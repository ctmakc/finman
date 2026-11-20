// services/statement/pdfWorker.mjs — reads a PDF from stdin, prints its text items per page as JSON.
// Runs as a separate process (see pdfText.js): a damaged or hostile PDF cannot hang or crash the
// server, and a timeout kills it.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = Number(process.argv[2]) || 30;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
try {
  const pdf = await getDocument({
    data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push((content.items || []).map((it) => ({ str: it.str, transform: it.transform, width: it.width, height: it.height })));
  }
  process.stdout.write(JSON.stringify({ ok: true, pageCount: pdf.numPages, pages }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.name) || 'Error') }));
}
