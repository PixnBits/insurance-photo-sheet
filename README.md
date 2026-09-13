# How to send photos to an insurance adjuster

A one-page how-to plus an in-browser tool. Someone who searched “send photos to insurance adjuster PDF” or “how to label photos for insurance claim” should be able to add photos, put them in order, write captions, and download a labeled photo-sheet PDF.

Photos never leave the browser. There is no account, no server, no upload.

Repo layout (GitHub Pages, **branch `main`, folder `/ (root)`**):

```
index.html
styles.css
app.js
README.md
```

## Run locally

Do not rely on `file://` — some browsers restrict modules and local file reads. Use a static server from this folder:

```bash
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/`.

Checklist:

1. Add five photos (JPEG / PNG / WebP).
2. Fix two captions.
3. Fill address / date / claim # if you want a cover page.
4. Click **Download PDF**.
5. Confirm: optional cover, then one photo per page with the caption underneath.

## Publish on GitHub Pages

1. Put `index.html`, `styles.css`, `app.js`, and this `README.md` at the root of a GitHub repository.
2. Repo **Settings → Pages → Build and deployment**.
3. Source: **Deploy from a branch**.
4. Branch: `main`, folder: `/ (root)`. Save.
5. The site is `https://pixnbits.github.io/insurance-photo-sheet/`.

jsPDF is loaded from jsDelivr. The published page needs network access for that script (and for GoatCounter, once enabled).

## Enable GoatCounter (metrics)

Page-use counts only. Photos, captions, address, filenames, and claim numbers are never sent.

GoatCounter is already pointed at `https://pixnbits.goatcounter.com/count` in `index.html`. `window.goatcounter.allow_local = true` is set so counts can appear when you click around on `127.0.0.1`.

Confirm in GoatCounter:

- A page view after a load.
- Custom events as paths like `event/add_photos/c3/t5` and `event/download_ok/n12/p13`.

Custom events use:

```js
goatcounter.count({ path: 'event/' + name, title: name, event: true })
```

Integers are appended to the path (`n12` = 12 photos, `p13` = 13 pages, `c3` = 3 files in that batch, `t8` = list length). No free text.

To point at a different GoatCounter site, change the `data-goatcounter` URL in `index.html`.

## Privacy

Nothing in `app.js` uploads files, thumbnails, captions, or cover fields. `track()` only sends event names and small integers (see the comment on `track()` in `app.js`). If GoatCounter is missing, blocked, or still a placeholder, the PDF tool still works.

## Known limits

- **HEIC / HEIF** (typical iPhone default) is not accepted. Export JPEG from Photos first, or set the camera to Most Compatible.
- **Huge sets.** Images are resized (long edge 1600px) and JPEG-compressed so an ~80 photo set has a chance of staying under ~20MB. If the estimate is large, a warning appears: split by elevation or floor. The browser may still run out of memory on hundreds of shots.
- **EXIF orientation.** Applied with `createImageBitmap(file, { imageOrientation: 'from-image' })`. Older browsers that lack that option may show sideways phone photos in the PDF. Rotate in Photos first if that happens.
- **jsPDF** is loaded from a CDN. Offline, download will fail with a library error.

## After two weeks on a public URL

Look at unique page views, `add_photos` / views, `download_ok` / `add_photos`, median `n` on `download_ok`, and `desk_accepted` vs `desk_bounced`. Do not chase bounce rate. If a desk bounces the file, the sentence they used is the next line of the ritual.
