<!--
  - SPDX-FileCopyrightText: 2026 Britton Couchman <brittondcouchman@gmail.com>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Changelog

## 0.1.5 – 2026-10-21

- DeckCraft 0.9.0 (commit 354087e): the latest DeckCraft, with the embedding bridge rebased onto it
- Still carries the fix for DeckCraft's browser version not opening or creating presentations (not in DeckCraft itself yet)

## 0.1.4 – 2026-10-16

- DeckCraft 0.7.0 (commit 1dc6972): the latest DeckCraft, with the embedding bridge rebased onto it
- Still carries the fix for DeckCraft's browser version not opening or creating presentations (not in DeckCraft itself yet)

## 0.1.3 – 2026-10-14

- DeckCraft 0.7.0 (commit 8d3e4a6): the latest DeckCraft, with the embedding bridge rebased onto it
- A fix for DeckCraft's browser version, which since this week couldn't open or create any presentation (it asked the browser for a process id, which panics there)

## 0.1.2 – 2026-10-12

- DeckCraft 0.6.1 (commit 688c7ef): the latest DeckCraft, with the embedding bridge rebased onto it

## 0.1.1 – 2026-10-11

- DeckCraft 0.5.0 (commit be14248): the latest DeckCraft, with the embedding bridge rebased onto it

## 0.1.0 – 2026-10-10

First release.

- App ID `integration_deckcraft`: "Edit in DeckCraft" in the Files action menu for PowerPoint or DeckCraft files (Nextcloud 33–35)
- Editor page with DeckCraft 0.5.0 (commit a98df49) in an iframe
- Save writes back over WebDAV with conflict detection; new formats and exports ask for a name and folder
- Read-only files save as a copy
- Optional "open presentations in DeckCraft when clicked", per user, with an admin default
