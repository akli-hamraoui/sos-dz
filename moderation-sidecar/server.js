/**
 * Rassemble moderation sidecar (Wave 3).
 *
 * Small local HTTP service wrapping NSFWJS (open-source, MIT-licensed,
 * free) so the Django backend can moderate photos before they are
 * published, without any paid third-party API, API key, or billing
 * account. This is the one deliberate exception to the "single
 * monolithic Django project" architecture (see rassemble-spec.md /
 * wave-1-core.md): NSFWJS is a Node/TensorFlow.js model that cannot run
 * inside the Python process, so it runs as its own small process on the
 * same server, called over local HTTP only. It is never exposed
 * publicly -- see DEPLOYMENT.md for the systemd unit that binds it to
 * 127.0.0.1.
 *
 * The NSFWJS classification model ships bundled inside the `nsfwjs` npm
 * package itself (dist/models/mobilenet_v2) -- `nsfw.load()` with no
 * arguments loads it from local files, no network call, no API key.
 */

const express = require("express");
const multer = require("multer");
const tf = require("@tensorflow/tfjs-node");
const nsfwjs = require("nsfwjs");

const PORT = process.env.PORT || 8801;
const HOST = process.env.HOST || "127.0.0.1";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const app = express();

let modelPromise = null;
function getModel() {
  if (!modelPromise) modelPromise = nsfwjs.load();
  return modelPromise;
}

// Sum of the categories NSFWJS itself considers unsafe. "Drawing" and
// "Neutral" are excluded -- a cartoon or an ordinary photo should not be
// treated as suspect content.
const UNSAFE_CLASSES = new Set(["Hentai", "Porn", "Sexy"]);

function combinedUnsafeScore(predictions) {
  return predictions
    .filter((p) => UNSAFE_CLASSES.has(p.className))
    .reduce((sum, p) => sum + p.probability, 0);
}

app.get("/health", async (req, res) => {
  try {
    await getModel();
    res.json({ status: "ok", model_loaded: true });
  } catch (e) {
    res.status(503).json({ status: "error", detail: String(e) });
  }
});

app.post("/classify", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: "No 'image' file in the request." });
  }
  try {
    const model = await getModel();
    const image = tf.node.decodeImage(req.file.buffer, 3);
    try {
      const predictions = await model.classify(image);
      const score = combinedUnsafeScore(predictions);
      res.json({ predictions, score });
    } finally {
      image.dispose(); // tf.Tensor memory must be released explicitly
    }
  } catch (e) {
    console.error("Classification failed:", e);
    res.status(500).json({ detail: "Classification failed", error: String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Rassemble moderation sidecar listening on http://${HOST}:${PORT}`);
  getModel().then(
    () => console.log("NSFWJS model loaded."),
    (e) => console.error("Failed to preload NSFWJS model:", e)
  );
});
