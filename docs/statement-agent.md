# Finman Statement Agent

A PDF or a photo of a bank or card statement goes in. Rows that are proven to the cent come out,
and they reach the ledger only after the person presses Import (or confirms the
`import_statement` card in the assistant / an MCP host).

## What happens to one statement

| Step | Where | What |
|---|---|---|
| 1. Look | `services/statement/agent.js` `detectKind`, `pdfText.js` | PDF with a text layer → pdf.js reads it locally, page by page, as aligned columns (in a separate process with a 20 s kill). Scan without text, or a JPG/PNG/WEBP photo → the vision path: the file itself goes to the model. |
| 2. Read | `agent.js` `SYSTEM`, `readOnce` | The model returns strict JSON: type (bank/card), currency, period, opening and closing **as printed**, rows (date, description, signed amount, running balance, page, unclear). It is told never to fix a number, and to mark an unreadable amount as unclear. |
| 3. Ground | `agent.js` `ground` | Text pages only: every amount the model returns must be printed on its page. An amount that is not there stops the import. |
| 4. Prove | `proof.js` `prove` | Integer cents. Bank: opening + Σ rows = closing. Card: opening − Σ rows = closing (balance = money owed). Every printed running balance is checked row by row; the first row where the chain breaks is reported with its page. |
| 5. Dates | `agent.js` `dateIssues` | The proof covers amounts only, so dates get their own check: inside the statement period (±3 days) and in printed order. |
| 6. Re-read | `agent.js` `read` | Not proven → only the failing page is read again, at most twice. The re-read prompt never contains the expected number, so the model cannot "make it balance". The best reading wins. |
| 7. Derive, never guess | `proof.js` `deriveUnclear` | One unreadable amount can be derived from the printed balances right before and after it; the totals check stays an independent second source. Shown as "from balances". |
| 8. Ask | `service.js` `setBalances` | No closing (or opening) printed → the person types it; Finman proves again without an AI call. |
| 9. Import | `service.js` `commit`, `services/importCommit.js` | Refused unless the status is `proven`, the dates are readable and the account currency matches. Multiset dedupe against what the account already holds, one db transaction, balance moved once. A task is claimed first, so a double click cannot import twice. |
| 10. Plan | `plan.js` | From the proven rows: income and spending per 30 days, repeating bills, top categories, projected balance, flexible spending per day. Labelled an estimate. |

Every task is stored in `statement_tasks` (migration 028) with the rows, the proof, the readings,
model calls, tokens and milliseconds. The file itself is not stored (only its sha-256), and only
the last 4 digits of the account number are kept.

## Which AI reads it

1. The person's own key from My AI (OpenAI, Claude, Gemini, OpenRouter, DeepSeek, Mistral, Groq,
   xAI, any OpenAI-compatible URL): `services/userAi/providers.js` `generate`. A scanned PDF needs
   Gemini, Claude or ChatGPT; other providers get `AI_NO_PDF` and the person is asked for photos.
2. Otherwise the instance AI, when configured (`STATEMENT_AI_PROVIDER=google` + `GEMINI_API_KEY`,
   see `DEPLOY.md`): `lib/ai/provider.js` `generate`, `STATEMENT_AI_MODEL` for text pages and
   `STATEMENT_AI_VISION_MODEL` for scans and photos, 15 statements per person per day.
3. No AI → CSV, OFX, QFX and QBO still import through the existing wizard without AI.

## Surfaces

- Web app: Banks & imports → Import a statement (also the first-run "Import a statement"):
  PDF/photo files go to `POST /api/statements`, CSV/OFX keep the old path.
- API: `routes/statements.js` (upload, view, typed balances, commit, delete).
- Assistant (own key) and MCP (`/mcp`, ChatGPT / Claude connectors): `list_statements`,
  `get_statement` (read), `import_statement` (write → Confirm card / host approval). An outside AI
  that read a statement itself can pass the rows with the printed opening and closing; Finman
  proves them the same way and writes nothing when they do not balance.

## Evaluation

`eval/statements/` — 32 generated statements (fictional banks and people, stamped SAMPLE DATA),
ground truth in `manifest.json`, generator `make_eval.mjs`: 20 text PDFs (CAD, USD, AED, EUR;
four date formats; withdrawals/deposits columns, signed amounts, CR/DR, parentheses, decimal
commas; 1–3 pages; 15–70 rows; 2 credit cards), 6 scans without a text layer, 6 phone photos
(tilt, blur, shadow); 8 with planted errors (dropped row, flipped sign, wrong digit, duplicated
row) and 2 without a closing balance.

```bash
STATEMENT_AI_PROVIDER=google GEMINI_API_KEY=… STATEMENT_AI_MODEL=gemini-3.5-flash-lite \
STATEMENT_AI_VISION_MODEL=gemini-3.8-flash node eval/run_eval.js        # writes eval/results/*.json
```

Results: see the newest file in `eval/results/` and the table below.

Run 20 Nov 2026 01:28–01:50 Toronto, `eval/results/gemini-3.5-flash-lite-2026-11-200650.json`: instance AI on the free Gemini tier, text pages
`gemini-3.5-flash-lite`, scans/photos `gemini-3.8-flash` (thinking low) with hand-over to the light
model when it is busy or silent.

| Metric | Result |
|---|---|
| Statements that balance on paper, proven with every row right (date + amount) | **22 / 22** (text PDF 14/14, scan 4/4, photo 4/4) |
| Planted errors caught (dropped row, flipped sign, wrong digit, duplicated row) | **8 / 8**, import refused; first breaking row shown in 6 of 8 (the other 2 print no running balance at that point, the gap is shown) |
| No closing balance → asked the person | **2 / 2** |
| False accepts (proven while wrong) | **0** |
| Rows read right, all 32 files | 1,044 / 1,045 (the miss is inside a planted-error file that was refused anyway) |
| Model calls per statement | median 1; 3 on refused files (first read + 2 page re-reads) |
| Tokens per statement (median in / out) | text PDF 2,212 / 3,207 · scan 1,340 / 2,797 · photo 2,481 / 2,118 |
| Seconds per statement (median, from Toronto to the free tier) | text PDF 7.8 (p90 19.1) · scan 115 · photo 93 — the vision model was slow and often handed over |
| Cost per statement at paid-tier prices (aistudio.google.com/docs/pricing, read 20 Nov 2026: 3.5 Flash-Lite $0.30/$2.50, 3.8 Flash $0.75/$3.75 per 1M) | median ≈ $0.009 text, ≈ $0.007 scan, ≈ $0.008 photo; max $0.03. Actual tonight: $0 (free tier) |

An earlier run the same night (light model on photos too) proved 2 of 6 photos with dates shifted by
one row while every amount was right: the reason scans and photos now go to the vision model and
the reason for the date check. Those two would have been false accepts on dates.

## Known limits

- The proof covers amounts. Dates are checked for period and order only; a date shifted by one
  row on a tilted photo still passes when it stays in order. The vision model was chosen because
  the light model did exactly that on 2 of 6 photos in the first run.
- A statement that prints neither opening nor closing (card activity pages) needs the person to
  type them.
- The proof cannot tell which row is wrong when the statement prints no running balance; it shows
  the gap and the person decides.
- Free-tier model limits on the instance AI: when the shared key is busy, the person sees "busy,
  try again", or adds their own key.
