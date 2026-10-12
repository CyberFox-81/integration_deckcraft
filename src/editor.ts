/**
 * SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * The editor page. DeckCraft runs in an iframe (templates/frame.php) and talks to this page
 * with postMessage (see web/README.md for the protocol):
 *
 *   DeckCraft → page   deckcraft:ready      the app is listening for a file
 *   page → DeckCraft   deckcraft:open       { name, path, bytes | blob } the file to open
 *   DeckCraft → page   deckcraft:need       { paths } files a project refers to (optional)
 *   page → DeckCraft   deckcraft:file       { path, blob | error } one of them
 *   DeckCraft → page   deckcraft:pick-save  { id, name } Save As or Export asks where to save (optional)
 *   page → DeckCraft   deckcraft:picked     { id, path } the answer (no path: cancelled)
 *   DeckCraft → page   deckcraft:save       { name, bytes, quiet? } Save (name) or Save As/Export (path);
 *                                       quiet: a file saved along with the presentation (its media)
 *   DeckCraft → page   deckcraft:dirty      { dirty } unsaved changes appeared or went away
 *   DeckCraft → page   deckcraft:failed     { error } the app couldn't start
 *
 * This page downloads and uploads over WebDAV with the user's session, so a save becomes a
 * new version of the file in Nextcloud.
 */

import { getRequestToken } from '@nextcloud/auth'
import { DialogBuilder, FilePickerClosed, getFilePickerBuilder, showConfirmation, showError, showSuccess, showWarning } from '@nextcloud/dialogs'
import { loadState } from '@nextcloud/initial-state'
import { t } from '@nextcloud/l10n'
import { basename, dirname, encodePath, extname, join } from '@nextcloud/paths'
import { generateRemoteUrl, generateUrl } from '@nextcloud/router'
import { appIcon } from './icon.ts'

import '@nextcloud/dialogs/style.css'

interface FileState {
	fileId: number
	name: string
	path: string
	canUpdate: boolean
	etag: string
	uid: string
}

interface Urls {
	frame: string
	files: string
}

/** A save that didn't reach Nextcloud, kept so it can be retried. */
interface Unsaved {
	name: string
	bytes: ArrayBuffer
	/** Saved along with the presentation (such as its media): no notice of its own. */
	quiet?: boolean
}

class HttpError extends Error {
	constructor(public readonly status: number) {
		super(`HTTP ${status}`)
	}
}

const APP = 'integration_deckcraft'
const file = loadState<FileState>(APP, 'file')
const urls = loadState<Urls>(APP, 'urls')
let openByDefault = loadState<boolean>(APP, 'openByDefault', false)

/**
 * Formats that keep the whole presentation. Saving in one of them can make that file the presentation's
 * file; anything else (PDF, PNG…) is an export, a copy that leaves the presentation where it is.
 */
const DOCUMENT_EXTENSIONS = new Set<string>(['.deckcraft', '.slidecraft', '.pptx', '.potx', '.ppsx'])

/**
 * Where a plain Save goes, by the file name DeckCraft saves under: the opened file's name at
 * first, and every name the user was asked about since (a new format, a read-only original), so
 * each is asked about once.
 */
const saveTargets = new Map<string, string>([[file.name, file.path]])
/** The latest ETag this page read or wrote for each path; uploads only replace that version. */
const etags = new Map<string, string>([[file.path, quoted(file.etag)]])
/** Paths this page may write to without asking: the opened file if writable, and new files. */
const writable = new Set<string>(file.canUpdate ? [file.path] : [])
/** Save As/Export locations the user picked, and whether they agreed to replace a file there. */
const picked = new Map<string, { replace: boolean }>()
/** The file the open presentation is saved to now. */
let documentPath = file.path

/** Hand files to DeckCraft as a `Blob` (large media) rather than a transferred `ArrayBuffer`. */
const OPEN_AS_BLOB = false

const unsaved = new Map<string, Unsaved>()
let frameDirty = false
let uploading = 0
let saveQueue: Promise<void> = Promise.resolve()
let opened = false
let leaving = false
/** A Save As dialog is waiting for the user. */
let choosingPath = false
/** Where Close goes: the folder of the file being edited, with the file highlighted. */
let filesUrl = urls.files

// ---------------------------------------------------------------------------------------------
// Page

const root = document.getElementById('deckcraft-editor')!
root.replaceChildren()

const bar = element('header', 'deckcraft-bar')
const icon = element('span', 'deckcraft-bar__icon')
icon.innerHTML = appIcon
icon.setAttribute('aria-hidden', 'true')
const title = element('h2', 'deckcraft-bar__title')
const status = element('span', 'deckcraft-bar__status')
status.setAttribute('role', 'status')
const retry = button(t('integration_deckcraft', 'Retry saving'), 'deckcraft-button deckcraft-button--primary', retrySaves)
const defaultToggle = element('label', 'deckcraft-bar__toggle')
const defaultCheckbox = document.createElement('input')
defaultCheckbox.type = 'checkbox'
defaultCheckbox.checked = openByDefault
defaultCheckbox.addEventListener('change', () => setOpenByDefault(defaultCheckbox.checked))
defaultToggle.append(defaultCheckbox, document.createTextNode(t('integration_deckcraft', 'Open presentations here from Files')))
defaultToggle.title = t('integration_deckcraft', 'Clicking a PowerPoint or DeckCraft file in Files opens it in DeckCraft')
const close = button(t('integration_deckcraft', 'Close'), 'deckcraft-button', closeEditor)
bar.append(icon, title, status, retry, defaultToggle, close)

const stage = element('div', 'deckcraft-stage')
const frame = document.createElement('iframe')
frame.className = 'deckcraft-frame'
frame.title = t('integration_deckcraft', 'DeckCraft presentation app')
frame.allow = 'fullscreen; clipboard-read; clipboard-write'
frame.src = urls.frame
const overlay = element('div', 'deckcraft-overlay')
stage.append(frame, overlay)
root.append(bar, stage)

setTitle(file.path)
showOverlay(t('integration_deckcraft', 'Opening {name} …', { name: file.name }, { escape: false }))
render()

// A frame that never answers usually means the server sends .wasm with the wrong MIME type.
const startTimeout = window.setTimeout(() => {
	if (!opened) {
		showOverlay(t('integration_deckcraft', 'DeckCraft is taking unusually long to start. If this persists, make sure your web server serves .wasm files as application/wasm.'), true)
	}
}, 45_000)

// The download starts with the page, alongside DeckCraft loading in the frame.
const initial = download(file.path)
initial.catch((error: unknown) => {
	window.clearTimeout(startTimeout)
	showOverlay(describeError(error, file.name, 'open'), true)
})

window.addEventListener('message', (event: MessageEvent) => {
	if (event.origin !== window.location.origin || event.source !== frame.contentWindow) {
		return
	}
	const data: unknown = event.data
	if (typeof data !== 'object' || data === null) {
		return
	}
	const message = data as Record<string, unknown>
	switch (message.type) {
	case 'deckcraft:ready':
		void openInFrame()
		break
	case 'deckcraft:pick-save':
		if (typeof message.id === 'number') {
			void answerPickSave(message.id, String(message.name ?? file.name))
		}
		break
	case 'deckcraft:save':
		if (message.bytes instanceof ArrayBuffer) {
			queueSave({ name: String(message.name ?? file.name), bytes: message.bytes, quiet: message.quiet === true })
		}
		break
	case 'deckcraft:need':
		if (Array.isArray(message.paths)) {
			void provideFiles(message.paths.filter((path): path is string => typeof path === 'string'))
		}
		break
	case 'deckcraft:dirty':
		frameDirty = message.dirty === true
		render()
		break
	case 'deckcraft:failed':
		window.clearTimeout(startTimeout)
		showOverlay(t('integration_deckcraft', 'DeckCraft couldn’t start: {error}', { error: String(message.error ?? '') }, { escape: false }), true)
		break
	}
})

window.addEventListener('beforeunload', (event) => {
	if (!leaving && hasUnsavedWork()) {
		event.preventDefault()
	}
})

// ---------------------------------------------------------------------------------------------
// Opening

async function openInFrame(): Promise<void> {
	try {
		// The first download is transferred to the frame; a reloaded frame gets the file as it
		// is in Nextcloud now.
		const { body, etag } = opened ? await download(documentPath) : await initial
		if (etag) {
			etags.set(opened ? documentPath : file.path, etag)
		}
		const name = opened ? basename(documentPath) : file.name
		const path = opened ? documentPath : file.path
		if (body instanceof Blob) {
			frame.contentWindow?.postMessage({ type: 'deckcraft:open', name, path, blob: body }, window.location.origin)
		} else {
			frame.contentWindow?.postMessage({ type: 'deckcraft:open', name, path, bytes: body }, window.location.origin, [body])
		}
		opened = true
		window.clearTimeout(startTimeout)
		hideOverlay()
	} catch (error) {
		window.clearTimeout(startTimeout)
		showOverlay(describeError(error, file.name, 'open'), true)
	}
}

async function download(path: string): Promise<{ body: ArrayBuffer | Blob, etag: string | null }> {
	const response = await fetch(davUrl(path), {
		headers: { requesttoken: getRequestToken() ?? '' },
		credentials: 'same-origin',
		cache: 'no-store',
	})
	if (!response.ok) {
		throw new HttpError(response.status)
	}
	return { body: OPEN_AS_BLOB ? await response.blob() : await response.arrayBuffer(), etag: response.headers.get('ETag') }
}

/**
 * Files an opened project refers to (its media), fetched from the user's Nextcloud and handed
 * to DeckCraft one by one. A path the user can't read is answered with an error, and DeckCraft
 * treats that file as missing.
 *
 * @param paths - User-relative paths
 */
async function provideFiles(paths: string[]): Promise<void> {
	for (const path of new Set(paths)) {
		try {
			const response = await fetch(davUrl(path), {
				headers: { requesttoken: getRequestToken() ?? '' },
				credentials: 'same-origin',
			})
			if (!response.ok) {
				throw new HttpError(response.status)
			}
			const blob = await response.blob()
			frame.contentWindow?.postMessage({ type: 'deckcraft:file', path, blob }, window.location.origin)
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			frame.contentWindow?.postMessage({ type: 'deckcraft:file', path, error: detail }, window.location.origin)
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Save As and Export: DeckCraft asks where, the user picks a name and folder here

async function answerPickSave(id: number, suggestedName: string): Promise<void> {
	const exporting = !isDocument(suggestedName)
	const path = await askSavePathWithStatus(suggestedName, dirname(documentPath), exporting ? 'export' : 'saveAs', true)
	frame.contentWindow?.postMessage({ type: 'deckcraft:picked', id, path }, window.location.origin)
}

// ---------------------------------------------------------------------------------------------
// Saving

function queueSave(save: Unsaved): void {
	uploading++
	render()
	saveQueue = saveQueue
		.then(() => store(save))
		.catch((error: unknown) => {
			unsaved.set(save.name, save)
			showError(describeError(error, basename(save.name), 'save'))
		})
		.finally(() => {
			uploading--
			render()
		})
}

/**
 * Upload one save. A path is a Save As or Export location picked here; a bare name is a plain
 * Save or an export, which goes to the file of that name it went to before (at first, only the
 * opened file), or asks where: a read-only original, a format the opened file isn't in, or an
 * export.
 */
async function store(save: Unsaved): Promise<void> {
	unsaved.delete(save.name)
	if (save.name.startsWith('/')) {
		await uploadPicked(save, save.name)
		return
	}
	const target = saveTargets.get(save.name)
	if (target !== undefined && writable.has(target)) {
		await uploadExisting(save, target)
		return
	}
	const reason: SaveReason = target !== undefined ? 'readOnly' : isDocument(save.name) ? 'newFormat' : 'export'
	const path = await askSavePathWithStatus(save.name, dirname(documentPath), reason, false)
	if (path === null) {
		if (reason === 'export') {
			// Declining an export is a choice, not a failed save.
			return
		}
		unsaved.set(save.name, save)
		showWarning(t('integration_deckcraft', '{name} was not saved to Nextcloud', { name: save.name }, { escape: false }))
		return
	}
	await uploadNew(save, path, reason !== 'export')
}

/** A location picked for Save As or Export: replacing a file there was already agreed. */
async function uploadPicked(save: Unsaved, path: string): Promise<void> {
	const choice = picked.get(path)
	picked.delete(path)
	if (path === documentPath && writable.has(path)) {
		await uploadExisting(save, path)
		return
	}
	if (choice === undefined && writable.has(path)) {
		// DeckCraft saves again to a file it saved before (not a new pick): that file is where the
		// presentation lives now.
		await uploadExisting(save, path, isDocument(path))
		return
	}
	if (choice?.replace) {
		await finishUpload(save, path, await put(path, save.bytes, {}))
		return
	}
	// A path DeckCraft chose itself (not picked here) for its own format is where the presentation
	// lives from now on.
	await uploadNew(save, path, choice === undefined && isDocument(path))
}

async function uploadExisting(save: Unsaved, path: string, newHome = false): Promise<void> {
	const etag = etags.get(path)
	const response = await put(path, save.bytes, etag ? { 'If-Match': etag } : {})
	if (response.status !== 412) {
		await finishUpload(save, path, response, newHome)
		return
	}
	// Someone else saved the file since this page read it.
	const choice = await choose(
		t('integration_deckcraft', 'This file was changed elsewhere'),
		t('integration_deckcraft', '{name} has been changed by someone else since you opened it. Saving now replaces their changes; a copy keeps both.', { name: basename(path) }, { escape: false }),
		[
			{ label: t('integration_deckcraft', 'Cancel'), value: 'cancel' },
			{ label: t('integration_deckcraft', 'Save a copy'), value: 'copy' },
			{ label: t('integration_deckcraft', 'Replace'), value: 'replace', variant: 'error' },
		],
		'cancel',
	)
	if (choice === 'replace') {
		await finishUpload(save, path, await put(path, save.bytes, {}), newHome)
	} else if (choice === 'copy') {
		const copy = await askSavePathWithStatus(basename(path), dirname(path), 'copy', false)
		if (copy === null) {
			unsaved.set(save.name, save)
		} else {
			await uploadNew(save, copy)
		}
	} else {
		unsaved.set(save.name, save)
		showWarning(t('integration_deckcraft', '{name} was not saved to Nextcloud', { name: basename(save.name) }, { escape: false }))
	}
}

/**
 * Upload to a new location, asking before replacing a file there.
 *
 * @param save - The save
 * @param path - Where it goes
 * @param newHome - A plain save that needed a new file: the presentation moves there
 */
async function uploadNew(save: Unsaved, path: string, newHome = false): Promise<void> {
	// Never replace an existing file without asking.
	let response = await put(path, save.bytes, { 'If-None-Match': '*' })
	if (response.status === 412) {
		if (!await confirmReplace(path)) {
			unsaved.set(save.name, save)
			showWarning(t('integration_deckcraft', '{name} was not saved to Nextcloud', { name: basename(path) }, { escape: false }))
			return
		}
		response = await put(path, save.bytes, {})
	}
	await finishUpload(save, path, response, newHome)
}

async function finishUpload(save: Unsaved, path: string, response: Response, newHome = false): Promise<void> {
	if (!response.ok) {
		throw new HttpError(response.status)
	}
	const etag = response.headers.get('OC-ETag') ?? response.headers.get('ETag') ?? await currentEtag(path)
	if (etag) {
		etags.set(path, quoted(etag))
	}
	writable.add(path)
	// A plain Save that had to go to a new file (read-only original, or a format the opened
	// file isn't in) moves the presentation there, and so does Save As in the format DeckCraft saves
	// in: later plain saves come here. Anything else (an export, or a copy in another format)
	// leaves the presentation where it is.
	const plainSave = !save.name.startsWith('/')
	if (plainSave) {
		saveTargets.set(save.name, path)
	}
	const moved = [...saveTargets].filter(([name, target]) => target === documentPath && extname(name).toLowerCase() === extname(path).toLowerCase())
	if (path !== documentPath && isDocument(path) && (newHome || (!plainSave && moved.length > 0))) {
		for (const [name] of moved) {
			saveTargets.set(name, path)
		}
		documentPath = path
		setTitle(path)
		// OC-FileId is the zero-padded id followed by the instance id.
		const id = Number.parseInt(response.headers.get('OC-FileId') ?? '', 10)
		if (Number.isFinite(id)) {
			window.history.replaceState(null, '', generateUrl('/apps/integration_deckcraft/edit/{fileId}', { fileId: id }))
			filesUrl = generateUrl('/apps/files/files/{fileId}?dir={dir}', { fileId: id, dir: dirname(path) })
		}
	}
	if (save.quiet) {
		// Part of saving the presentation, which has its own notice.
	} else if (path === documentPath || (plainSave && isDocument(path))) {
		showSuccess(t('integration_deckcraft', 'Saved {name} to Nextcloud', { name: basename(path) }, { escape: false }))
	} else if (isDocument(path)) {
		showSuccess(t('integration_deckcraft', 'Saved a copy as {name}', { name: basename(path) }, { escape: false }))
	} else {
		showSuccess(t('integration_deckcraft', 'Exported {name} to Nextcloud', { name: basename(path) }, { escape: false }))
	}
	render()
}

async function put(path: string, bytes: ArrayBuffer, conditions: Record<string, string>): Promise<Response> {
	const send = () => fetch(davUrl(path), {
		method: 'PUT',
		headers: {
			requesttoken: getRequestToken() ?? '',
			'Content-Type': 'application/octet-stream',
			...conditions,
		},
		body: bytes,
		credentials: 'same-origin',
	})
	const response = await send()
	// 404 or 409: the folder doesn't exist yet, as when DeckCraft saves into a new folder (such as
	// a project's media).
	if (response.status !== 404 && response.status !== 409) {
		return response
	}
	await createFolder(dirname(path))
	return send()
}

/**
 * Create a folder and the folders above it that don't exist yet.
 *
 * @param path - User-relative folder path
 */
async function createFolder(path: string): Promise<void> {
	let folder = ''
	for (const part of path.split('/').filter((p) => p !== '')) {
		folder += `/${part}`
		const response = await fetch(davUrl(folder), { method: 'MKCOL', headers: { requesttoken: getRequestToken() ?? '' }, credentials: 'same-origin' })
		// 405: the folder exists already.
		if (!response.ok && response.status !== 405) {
			throw new HttpError(response.status)
		}
	}
}

async function currentEtag(path: string): Promise<string | null> {
	try {
		const response = await fetch(davUrl(path), { method: 'HEAD', headers: { requesttoken: getRequestToken() ?? '' }, credentials: 'same-origin', cache: 'no-store' })
		return response.ok ? response.headers.get('ETag') : null
	} catch {
		return null
	}
}

async function exists(path: string): Promise<boolean> {
	const response = await fetch(davUrl(path), { method: 'HEAD', headers: { requesttoken: getRequestToken() ?? '' }, credentials: 'same-origin', cache: 'no-store' })
	return response.ok
}

function confirmReplace(path: string): Promise<boolean> {
	return showConfirmation({
		name: t('integration_deckcraft', 'Replace {name}?', { name: basename(path) }, { escape: false }),
		text: t('integration_deckcraft', 'A file named {name} already exists in {folder}.', { name: basename(path), folder: folderLabel(dirname(path)) }, { escape: false }),
		labelConfirm: t('integration_deckcraft', 'Replace'),
		labelReject: t('integration_deckcraft', 'Cancel'),
		severity: 'warning',
	})
}

function retrySaves(): void {
	const pending = [...unsaved.values()]
	unsaved.clear()
	pending.forEach(queueSave)
	render()
}

// ---------------------------------------------------------------------------------------------
// The Save As dialog

type SaveReason = 'saveAs' | 'export' | 'readOnly' | 'newFormat' | 'copy'

async function askSavePathWithStatus(name: string, folder: string, reason: SaveReason, checkExisting: boolean): Promise<string | null> {
	choosingPath = true
	render()
	try {
		return await askSavePath(name, folder, reason, checkExisting)
	} finally {
		choosingPath = false
		render()
	}
}

/**
 * Ask for a file name and folder. Returns the user-relative path, or `null` when cancelled.
 * With `checkExisting`, a name that's taken asks before replacing it, and the answer is
 * remembered for the upload that follows.
 *
 * @param name - The suggested file name, whose extension sets the format
 * @param startFolder - The folder to offer first
 * @param reason - Why we ask
 * @param checkExisting - Ask about replacing an existing file now rather than at upload
 */
async function askSavePath(name: string, startFolder: string, reason: SaveReason, checkExisting: boolean): Promise<string | null> {
	let folder = startFolder
	const extension = extname(name)
	const suggested = reason === 'readOnly' || reason === 'copy' ? withSuffix(name, t('integration_deckcraft', 'edited')) : name

	const dialog = element('dialog', 'deckcraft-save') as HTMLDialogElement
	const form = document.createElement('form')
	form.method = 'dialog'
	const heading = element('h2', 'deckcraft-save__heading')
	heading.textContent = {
		saveAs: t('integration_deckcraft', 'Save as'),
		export: t('integration_deckcraft', 'Export'),
		readOnly: t('integration_deckcraft', 'This file is read-only'),
		newFormat: t('integration_deckcraft', 'Save as a new file'),
		copy: t('integration_deckcraft', 'Save a copy'),
	}[reason]
	const hint = element('p', 'deckcraft-save__hint')
	hint.textContent = {
		saveAs: '',
		export: t('integration_deckcraft', 'The export is a copy; your presentation stays as it is.'),
		readOnly: t('integration_deckcraft', 'You can’t change {name}, but you can save your edits as a new file.', { name: basename(documentPath) }, { escape: false }),
		newFormat: t('integration_deckcraft', 'DeckCraft saves {name} in a different format, so it goes to a new file and the original stays as it is.', { name: basename(documentPath) }, { escape: false }),
		copy: '',
	}[reason]
	hint.hidden = hint.textContent === ''

	const nameLabel = element('label', 'deckcraft-save__label')
	nameLabel.textContent = t('integration_deckcraft', 'File name')
	const nameInput = document.createElement('input')
	nameInput.type = 'text'
	nameInput.required = true
	nameInput.value = suggested
	nameInput.className = 'deckcraft-save__input'
	nameLabel.append(nameInput)

	const folderRow = element('div', 'deckcraft-save__folder')
	const folderText = element('span', 'deckcraft-save__folder-path')
	const showFolder = () => {
		folderText.textContent = t('integration_deckcraft', 'In {folder}', { folder: folderLabel(folder) }, { escape: false })
	}
	showFolder()
	const pickFolder = button(t('integration_deckcraft', 'Change folder …'), 'deckcraft-button', async () => {
		// The picker is its own modal; ours steps aside meanwhile.
		dialog.close('picking')
		const chosen = await chooseFolder(folder)
		if (chosen !== null) {
			folder = chosen
			showFolder()
		}
		dialog.returnValue = ''
		dialog.showModal()
		nameInput.focus()
	})
	folderRow.append(folderText, pickFolder)

	const error = element('p', 'deckcraft-save__error')
	error.setAttribute('role', 'alert')
	const actions = element('div', 'deckcraft-save__actions')
	const cancel = button(t('integration_deckcraft', 'Cancel'), 'deckcraft-button', () => dialog.close('cancel'))
	const submit = document.createElement('button')
	submit.type = 'submit'
	submit.value = 'save'
	submit.className = 'deckcraft-button deckcraft-button--primary'
	submit.textContent = reason === 'export' ? t('integration_deckcraft', 'Export') : t('integration_deckcraft', 'Save')
	actions.append(cancel, submit)

	form.append(heading, hint, nameLabel, folderRow, error, actions)
	dialog.append(form)
	document.body.append(dialog)

	return new Promise((resolve) => {
		let done = false
		const finish = (path: string | null) => {
			if (done) {
				return
			}
			done = true
			if (dialog.open) {
				dialog.close('done')
			}
			dialog.remove()
			// Clicks and keyboard shortcuts go back to DeckCraft.
			focusEditor()
			resolve(path)
		}
		form.addEventListener('submit', async (event) => {
			event.preventDefault()
			const problem = invalidName(nameInput.value)
			if (problem) {
				error.textContent = problem
				nameInput.focus()
				return
			}
			const path = join(folder, withExtension(nameInput.value.trim(), extension))
			if (checkExisting && path !== documentPath) {
				submit.disabled = true
				let replace = false
				try {
					if (await exists(path)) {
						dialog.close('picking')
						replace = await confirmReplace(path)
						if (!replace) {
							dialog.returnValue = ''
							dialog.showModal()
							nameInput.focus()
							return
						}
					}
				} catch {
					// Can't tell: the upload still refuses to replace a file without asking.
				} finally {
					submit.disabled = false
				}
				picked.set(path, { replace })
			}
			finish(path)
		})
		// Cancel, Escape: nothing picked.
		dialog.addEventListener('close', () => {
			if (dialog.returnValue !== 'picking') {
				finish(null)
			}
		})
		dialog.showModal()
		// Select the name without its extension, like the Files app does on rename.
		const stem = nameInput.value.length - extname(nameInput.value).length
		nameInput.setSelectionRange(0, stem > 0 ? stem : nameInput.value.length)
		nameInput.focus()
	})
}

async function chooseFolder(start: string): Promise<string | null> {
	let chosen: string | null = null
	try {
		await getFilePickerBuilder(t('integration_deckcraft', 'Choose a folder'))
			.allowDirectories(true)
			.setMimeTypeFilter(['httpd/unix-directory'])
			.startAt(start)
			.setButtonFactory((selected, currentPath) => [{
				label: selected.length === 1 ? t('integration_deckcraft', 'Choose {folder}', { folder: selected[0]!.basename }, { escape: false }) : t('integration_deckcraft', 'Choose this folder'),
				variant: 'primary',
				callback: () => {
					chosen = selected.length === 1 ? selected[0]!.path : currentPath
				},
			}])
			.build()
			.pick()
	} catch (error) {
		if (!(error instanceof FilePickerClosed)) {
			throw error
		}
	}
	return chosen
}

function invalidName(raw: string): string | null {
	const name = raw.trim()
	if (name === '' || name.startsWith('.') && extname(name) === name) {
		return t('integration_deckcraft', 'Enter a file name.')
	}
	if (name.includes('/') || name.includes('\\')) {
		return t('integration_deckcraft', 'A file name can’t contain “/” or “\\”.')
	}
	if (name === '.' || name === '..') {
		return t('integration_deckcraft', '“{name}” is not a valid file name.', { name }, { escape: false })
	}
	return null
}

// ---------------------------------------------------------------------------------------------
// Leaving

async function closeEditor(): Promise<void> {
	if (hasUnsavedWork()) {
		const leave = await showConfirmation({
			name: t('integration_deckcraft', 'Leave without saving?'),
			text: uploading > 0
				? t('integration_deckcraft', 'A save is still being uploaded. If you leave now it may not reach Nextcloud.')
				: t('integration_deckcraft', 'Your latest changes have not been saved to Nextcloud.'),
			labelConfirm: t('integration_deckcraft', 'Leave'),
			labelReject: t('integration_deckcraft', 'Keep editing'),
			severity: 'warning',
		})
		if (!leave) {
			return
		}
	}
	leaveTo(filesUrl)
}

/** Leave the editor when the user has already chosen to (or nothing is unsaved). */
function leaveTo(url: string): void {
	leaving = true
	// DeckCraft may ask the browser to confirm leaving while it has unsaved changes. The user has
	// answered our question already, and removing the frame first spares them a second one.
	frame.remove()
	window.location.assign(url)
}

function hasUnsavedWork(): boolean {
	return frameDirty || uploading > 0 || unsaved.size > 0
}

async function setOpenByDefault(enabled: boolean): Promise<void> {
	try {
		const response = await fetch(generateUrl('/apps/integration_deckcraft/preferences'), {
			method: 'PUT',
			headers: { requesttoken: getRequestToken() ?? '', 'Content-Type': 'application/json' },
			body: JSON.stringify({ openByDefault: enabled }),
			credentials: 'same-origin',
		})
		if (!response.ok) {
			throw new HttpError(response.status)
		}
		openByDefault = enabled
		showSuccess(enabled
			? t('integration_deckcraft', 'Presentations you click in Files now open in DeckCraft')
			: t('integration_deckcraft', 'Presentations you click in Files open with your previous default again'))
	} catch {
		defaultCheckbox.checked = openByDefault
		showError(t('integration_deckcraft', 'Couldn’t save this setting'))
	}
}

// ---------------------------------------------------------------------------------------------
// Helpers

function render(): void {
	let text: string
	let state: string
	if (choosingPath) {
		text = t('integration_deckcraft', 'Choose where to save …')
		state = 'busy'
	} else if (uploading > 0) {
		text = t('integration_deckcraft', 'Saving to Nextcloud …')
		state = 'busy'
	} else if (unsaved.size > 0) {
		text = t('integration_deckcraft', 'Not saved to Nextcloud')
		state = 'error'
	} else if (frameDirty) {
		text = t('integration_deckcraft', 'Unsaved changes')
		state = 'dirty'
	} else if (!writable.has(documentPath)) {
		text = t('integration_deckcraft', 'Read-only: saving makes a copy')
		state = 'readonly'
	} else {
		text = ''
		state = 'clean'
	}
	status.textContent = text
	status.dataset.state = state
	retry.hidden = unsaved.size === 0 || uploading > 0
}

/** Give DeckCraft's canvas the focus again (same origin, so this page can reach into the frame). */
function focusEditor(): void {
	frame.focus()
	frame.contentDocument?.getElementById('deckcraft_canvas')?.focus()
}

function setTitle(path: string): void {
	title.textContent = basename(path)
	title.title = path
	document.title = `${basename(path)} - DeckCraft`
}

function showOverlay(text: string, isError = false): void {
	overlay.replaceChildren()
	if (!isError) {
		overlay.append(element('span', 'deckcraft-overlay__spinner icon-loading'))
	}
	const message = element('p', 'deckcraft-overlay__text')
	message.textContent = text
	overlay.append(message)
	if (isError) {
		overlay.append(button(t('integration_deckcraft', 'Back to Files'), 'deckcraft-button', () => leaveTo(filesUrl)))
	}
	overlay.dataset.error = String(isError)
	overlay.hidden = false
}

function hideOverlay(): void {
	overlay.hidden = true
}

function describeError(error: unknown, name: string, action: 'open' | 'save'): string {
	if (error instanceof HttpError) {
		switch (error.status) {
		case 401:
		case 403:
			return action === 'open'
				? t('integration_deckcraft', 'You don’t have permission to open {name}.', { name }, { escape: false })
				: t('integration_deckcraft', 'You don’t have permission to save {name} there.', { name }, { escape: false })
		case 404:
			return t('integration_deckcraft', '{name} no longer exists.', { name }, { escape: false })
		case 423:
			return t('integration_deckcraft', '{name} is locked by another app or user. Try again later or save a copy.', { name }, { escape: false })
		case 507:
			return t('integration_deckcraft', 'There is not enough storage space to save {name}.', { name }, { escape: false })
		}
	}
	const detail = error instanceof Error ? error.message : String(error)
	return action === 'open'
		? t('integration_deckcraft', 'Couldn’t open {name}: {detail}', { name, detail }, { escape: false })
		: t('integration_deckcraft', 'Couldn’t save {name}: {detail}', { name, detail }, { escape: false })
}

/**
 * Show a dialog with several choices and resolve to the one picked.
 *
 * @param name - Heading
 * @param text - Explanation
 * @param choices - Buttons, in display order
 * @param fallback - The result when the dialog is dismissed
 */
function choose<T>(name: string, text: string, choices: { label: string, value: T, variant?: 'primary' | 'secondary' | 'error' }[], fallback: T): Promise<T> {
	let result = fallback
	const dialog = new DialogBuilder(name)
		.setText(text)
		.setSeverity('warning')
		.setButtons(choices.map((choice) => ({
			label: choice.label,
			variant: choice.variant,
			callback: () => {
				result = choice.value
			},
		})))
		.build()
	return dialog.show().then(() => result)
}

/** A folder as the Files app names it: "All files" for the root, otherwise its path. */
function folderLabel(dir: string): string {
	return dir === '/' || dir === '' ? t('integration_deckcraft', 'All files') : dir.replace(/^\//, '')
}

function isDocument(name: string): boolean {
	return DOCUMENT_EXTENSIONS.has(extname(name).toLowerCase())
}

function davUrl(path: string): string {
	return generateRemoteUrl(`dav/files/${encodeURIComponent(file.uid)}`) + encodePath(path)
}

function quoted(etag: string): string {
	return etag.startsWith('"') || etag.startsWith('W/') ? etag : `"${etag}"`
}

/** `name` with an extension: the one typed, or else `extension`. */
function withExtension(name: string, extension: string): string {
	return extname(name) === '' && extension !== '' ? `${name}${extension}` : name
}

/** "Report.ext" → "Report (edited).ext". */
function withSuffix(name: string, suffix: string): string {
	const extension = extname(name)
	return `${name.slice(0, name.length - extension.length)} (${suffix})${extension}`
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	node.className = className
	return node
}

function button(label: string, className: string, onClick: () => unknown): HTMLButtonElement {
	const node = element('button', className)
	node.type = 'button'
	node.textContent = label
	node.addEventListener('click', () => {
		void onClick()
	})
	return node
}
