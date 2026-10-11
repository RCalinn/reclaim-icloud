# Reclaim iCloud

A Firefox extension that finds bursts, retakes and duplicate copies in your iCloud Photos library, suggests the best shot of each set to keep, and moves the rest to **Recently Deleted**.

It talks to iCloud through the iCloud Photos website you're signed in to, using iCloud's undocumented web API. Photos are compared on your computer by a small built-in AI model (DINOv2), which recognises the same scene even when people moved, the camera angle or zoom changed, or the light is different. Nothing is uploaded anywhere else.

## What you need

- **Firefox 115 or newer** on a computer (it isn't a mobile extension).
- An Apple account with **iCloud Photos** that you can open at [icloud.com/photos](https://www.icloud.com/photos). If you use Advanced Data Protection, turn on **Access iCloud Data on the Web** on your iPhone first (Settings → your name → iCloud).

## 1. Load the extension

1. Download this project: on GitHub click **Code → Download ZIP**, then unzip it (or `git clone` it).
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `manifest.json` from the unzipped folder.
4. A **Find similar photos** button appears in the toolbar.

Firefox removes temporary add-ons when it quits, so repeat this each time you restart Firefox. After you change any file, click **Reload** on the same page.

## 2. Connect to iCloud

1. Open [icloud.com/photos](https://www.icloud.com/photos) in a tab, sign in, and wait until your photos appear.
2. Click **Find similar photos** in the toolbar. The review page opens in a new tab.
3. The top of the page shows the connection status:

| Status | What to do |
|---|---|
| **Connected to iCloud** | Ready. |
| **Open icloud.com/photos in a tab** | Open and sign in to iCloud Photos. |
| **Reload the iCloud Photos tab** | Reload the iCloud tab once; the extension learns how to reach your library from the requests that page makes. |

Keep the iCloud Photos tab open the whole time. The extension sends its requests through it.

## 3. Scan

Click **Scan library**. The extension lists your library, then downloads a small thumbnail of every photo and compares them. The status line shows progress, speed and the time left.

- The first scan takes a while, because the AI model looks at every photo: roughly 5–10 photos a second depending on the computer, so about 15–25 minutes for 7,000 photos. Keep both tabs open until it finishes. If it's interrupted, the next scan continues where it stopped.
- Results are saved, so later scans only analyse photos added since.
- If the model can't run, the status line says so and photos are compared the basic way (less accurate).
- Videos are counted but not scanned.

## 4. Review

Similar photos are shown as cards, grouped by month, oldest first.

- **Similarity** (Strict ↔ Loose) sets how alike photos must look to be grouped. **Time window** (10 s ↔ 1 h) sets how close in time retakes must be. Groups update as you drag. Copies of the same photo saved much later are found at any time gap.
- In each set, the best photo is kept: a favourite first, then the highest resolution, then the best exposed (fewest areas blown out to white or crushed to black), then the sharpest, then the largest file. The others are suggested for deletion. **Favourites are never suggested for deletion.**
- Click **Keep** / **Delete** under a photo to change it. A card warns you with **Nothing kept** if you mark every photo in a set.
- Click a photo (or hover and press Space) to open a large preview:

| Key | Action |
|---|---|
| ← → | Previous / next photo |
| K / D | Keep / delete this photo |
| O | Keep only this photo, delete the rest of its set |
| C | Compare side by side with the suggested keeper |
| Space / Esc | Close |

Your Keep/Delete choices are saved as you go, so you can close the page and come back.

Not sure which Similarity level suits your photos? **Check accuracy** shows you pairs to label as same shot or different, then suggests the level that fits your answers best.

## 5. Delete

- **Move to Recently Deleted** (bar at the bottom) acts on everything marked in the whole library.
- **Delete N from *Month*** (at the top of each month) acts on one month only.

A confirmation shows how many photos and how much space. The photos go to **Recently Deleted** in iCloud, where you can recover them for 30 days. The space is freed once Recently Deleted is emptied (or after 30 days).

For a first run, delete one small month and check the result in iCloud Photos → Recently Deleted before doing more.

## Troubleshooting

- **"iCloud 401" or "iCloud 421 (session expired?)":** your iCloud session expired. Reload the iCloud Photos tab, sign in again if asked, then retry.
- **"N thumbnails couldn't load · Retry":** iCloud throttled or timed out some downloads. Click **Retry**, or click a failed photo to retry it alone. Expired download links are renewed automatically.
- **Status stuck on "Reload the iCloud Photos tab":** reload the iCloud tab after the extension is loaded, not before.
- **Errors in the scan:** open the review page's console (Cmd+Option+K on a Mac, Ctrl+Shift+K elsewhere) for details.

## For developers

No build step; the files load as-is. Node 22 or newer:

```sh
npm test        # unit tests
npm install     # once, for the end-to-end tests
npm run e2e     # review page in headless Firefox against a fake iCloud
```

See `CLAUDE.md` for the architecture and the larger test scripts.

Bundled third-party files: `vendor/ort/` is [onnxruntime-web](https://github.com/microsoft/onnxruntime) 1.30.0 (MIT licence), `models/dinov2-small-int8.onnx` is [DINOv2-small](https://github.com/facebookresearch/dinov2) (Apache 2.0) as converted by [onnx-community/dinov2-small](https://huggingface.co/onnx-community/dinov2-small). The model test (`tests/embed.test.js`) uses eight photos from [INRIA Holidays](https://thoth.inrialpes.fr/~jegou/data.php.html) (Jégou, Douze & Schmid, ECCV 2008). INRIA holds their copyright, so they aren't in this repository and the test is skipped without them. Licence texts for the bundled files are in `vendor/ort/LICENSE` and `models/LICENSE`.

SHA-256 of the bundled binaries (the model matches `onnx/model_quantized.onnx` on Hugging Face), to check with `shasum -a 256`:

    11e64bd8ffe11bd1a2a2f0d6275fdfbbba7262f0b76b99b53d228a8a22ef3d90  vendor/ort/ort.wasm.bundle.min.mjs
    3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2  vendor/ort/ort-wasm-simd-threaded.wasm
    c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb  models/dinov2-small-int8.onnx
