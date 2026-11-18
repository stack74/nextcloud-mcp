/**
 * Server-level instructions, sent to the client during initialization.
 * Keep this about where to start and decision points, not field reference.
 */

export const SERVER_INSTRUCTIONS = `This server gives access to the files of ONE Nextcloud user — the person who connected it — with exactly their permissions: their own files plus everything shared with them.

# Finding things

- Do not walk the folder tree to find something. \`nextcloud_search_files\` searches the whole Nextcloud by name, type and date in one request.
- "What did I/we work on recently?" -> \`nextcloud_search_files\` without a query (newest first).
- Words INSIDE documents -> \`nextcloud_search_file_contents\` with the narrowest folder you can name. It reads files one by one, so a broad folder only covers the newest files.
- \`nextcloud_list_files\` is for looking into one known folder.
- \`nextcloud_unified_search\` covers other Nextcloud apps (calendar, contacts, Talk, Deck, …) and, if installed, the full-text index.

# Reading

- \`nextcloud_read_file\` returns text for text files, PDFs, Word, Excel, PowerPoint and OpenDocument files, and the image itself for pictures. Long content comes in chunks: follow the offset it gives you instead of guessing.
- Scanned PDFs have no text layer -> look at them with \`nextcloud_get_preview\`.
- To look at or compare several pictures (photos, product images, scans, slides), use \`nextcloud_get_previews\` with a folder or a list of paths: one call, numbered thumbnails. \`include_previews\` on list/search adds a few small ones to the results.
- Paths are case-sensitive and start at the user's root, e.g. "/Documents/Offer 2026.pdf". Copy them exactly from list/search results.

# Changing files (only if the write tools are present)

- If upload/create/move/delete tools are missing, the server is read-only. Say so; \`nextcloud_whoami\` confirms it.
- Nothing is overwritten unless you pass overwrite=true. Only do that when the user asked to replace the file.
- Before \`nextcloud_delete\`, tell the user exactly what will be deleted and get a clear yes. Deleted items go to the trash bin and can be restored with \`nextcloud_restore_from_trash\`.
- Moving or deleting files in folders shared with others affects those people too.`;
