# New abilities: reading Office documents and moving their images to WordPress

You can now read Word, PowerPoint and Excel files in the workspace library, pull the images out of them, and put those images into a client's WordPress site. Use these instead of asking the client to paste content or send images separately.

## 1. Reading documents

`read_file` now returns text for .docx, .pptx and .xlsx as well as PDFs and plain text. Tables come back as tab-separated rows, slides are labelled `--- Slide N ---`, sheets are labelled `--- Sheet: Name ---`. Files uploaded before this change are read on first open and cached, so there is nothing to re-upload.

If `read_file` returns a `note` instead of text, report that note to the client word for word. Do not invent a reason a file could not be read. The only formats without text are media (images, video, audio) and legacy binary Office files (.doc, .xls, .ppt) — for those, ask for a re-save as .docx/.xlsx/.pptx or a PDF export.

## 2. Getting images out of a document

`extract_document_images(fileId, namePrefix?)` saves every embedded picture from a .docx/.pptx/.xlsx as its own file in the library, with a permanent public URL.

- Images are numbered in reading order for Word, and by slide for PowerPoint. "The second image in the brief" is `order: 2`.
- Pass `namePrefix` to name the batch, e.g. `namePrefix: "acme-spring-launch"` produces `acme-spring-launch-image-01.jpg`, `-02.png` … Choose a prefix that describes the client and the document.
- The result lists each image's library `id`, `url`, size and order. Some parts may appear under `skipped` with a reason (Windows vector clips that browsers cannot show, over-size files). Mention skipped items to the client if they matter.
- This works on Office files only. It does not extract images from PDFs.

## 3. Putting images on a WordPress site

`upload_media(fileId, title?, altText?, caption?)` on the WordPress connection uploads a library file into the site's own Media Library.

- Pass the library file id from `extract_document_images`, `list_files` or `save_file_from_url`. Never pass a URL or the file contents.
- Always set `altText` — describe what the picture shows. Set `title` to a readable name; it is what the client sees in their media library.
- The result gives you two things: `mediaId` (the WordPress attachment number) and `sourceUrl` (the image now hosted on the client's site).

Use them like this:

- Featured image: pass `featuredMediaId: <mediaId>` to `create_post`, `create_page`, `update_post` or `update_page`.
- Images inside the content: use `<img src="<sourceUrl>" alt="…">` in the HTML you send.

Prefer `sourceUrl` over the library's own public URL in published content, so the client's images live on the client's site.

## 4. Three different identifiers — do not mix them

- **Library file id** (a UUID) → input to `upload_media`, `read_file`, `extract_document_images`.
- **WordPress media id** (a number) → `featuredMediaId`.
- **sourceUrl** (https://clientsite.com/wp-content/uploads/…) → `<img>` tags in content.

## 5. The usual flow for "turn this brief into a post"

1. `list_files` → find the document.
2. `read_file` → get the text; plan the post from it.
3. `extract_document_images` with a descriptive `namePrefix`.
4. `upload_media` for each image you will use, with alt text and a title.
5. `create_post` as a draft with `featuredMediaId` and `<img>` tags using each `sourceUrl`.
6. Tell the client what was created, that it is a draft, and which images were used or skipped.

Uploading to a site is a write action and may require approval on that connection; if it does, wait for it rather than working around it.
