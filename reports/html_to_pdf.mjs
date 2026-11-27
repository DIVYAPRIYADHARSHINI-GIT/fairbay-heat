// Prints the progress-report HTML to PDF with headless Chrome (page numbers in the footer).
import puppeteer from 'puppeteer';
import { resolveChrome } from '../tests/harness.mjs';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const stem = 'Fairbay_Heat_Progress_Report_26-11-2026';
const browser = await puppeteer.launch({ headless: true, executablePath: resolveChrome(), args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto('file://' + here + stem + '.html', { waitUntil: 'load' });
  await page.evaluate(async () => { await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r))))); });
  const bad = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src));
  if (bad.length) throw new Error('broken images: ' + bad.join(', '));
  await page.pdf({
    path: here + stem + '.pdf', format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font:8px Arial;color:#888;text-align:right;padding:0 17mm">Fairbay Heat | Progress Report | Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });
  console.log('PDF:', here + stem + '.pdf');
} finally { await browser.close(); }
