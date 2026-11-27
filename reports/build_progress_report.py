"""Fairbay Heat progress report (team template) as HTML, printed to PDF by html_to_pdf.mjs.

Layout follows the team's PROGRESS REPORT template: centred title with the date, then
Product Designed / Platform Used / AI Model Used, Product Details, Deliverables, Bug, Link.
Every figure comes from the repo (git log, README, test logs) or Designer's own records.

Run:  python3 reports/build_progress_report.py && node reports/html_to_pdf.mjs
"""
from __future__ import annotations

import html
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SHOTS = ROOT / 'docs' / 'screenshots'
DATE_TITLE = '26th Nov 2026'
STEM = 'Fairbay_Heat_Progress_Report_26-11-2026'
LIVE = 'https://fairbay-heat.vercel.app'
REPO = 'https://github.com/DIVYAPRIYADHARSHINI-GIT/fairbay-heat'

E = html.escape


def field(label: str, value: str) -> str:
    return f'<p class="field"><b>{E(label)}</b> {value}</p>'


def items(lst: list[str]) -> str:
    return ''.join(f'<p class="item">{i}. {t}</p>' for i, t in enumerate(lst, 1))


def fig(name: str, cap: str) -> str:
    jpg = HERE / 'img' / name.replace('.png', '.jpg')
    assert jpg.exists(), jpg
    return f'<figure><img src="img/{jpg.name}"><figcaption>{E(cap)}</figcaption></figure>'


parts: list[str] = []
add = parts.append
add(f'<h1>PROGRESS REPORT ({DATE_TITLE})</h1>')
add(field('Product Designed:', 'Fairbay Heat - Open-World Street Racing Game (browser, inspired by NFS Most Wanted 2013)'))
add(field('Platform Used:', 'Designer v0.0.37 (Stages 1-4, 25-26 Nov) and v0.0.38 (Round 5 fixes, 26 Nov 2026)'))
add(field('AI Model Used:', 'Claude Opus 5.5 (High effort on 25 Nov, then Max effort)'))

add('<p class="label"><b>Product Details:</b></p>')
add(items([
    '<b>Stage 1 - Open-world driving (25 Nov):</b> my own physics, input, camera, HUD, menus and Web Audio (Three.js only draws). '
    '6 stylized cars with look-alike names, jack spots (E), garage, handbrake drift, nitro, jumps, crashes, day/night, minimap.',
    '<b>Stage 2 - City and traffic (25 Nov):</b> hand-made asymmetric map (143 roads, 31.5 km: downtown, I-9 viaduct, harbour, hills, airfield, '
    'mountain pass), up to 48 traffic cars that follow lanes and lights, physically-modelled engine sound.',
    '<b>Stage 3 - Police chases (25 Nov):</b> patrols in traffic that only see you in their view, heat levels 1-5, units that follow the roads, '
    'PIT, roadblocks, cooldown/escape, busted, sirens, pursuit HUD.',
    '<b>Stage 4 - Races and speed events (26 Nov):</b> 4 races against AI rivals with checkpoints, laps and best times (traffic cut to about a third '
    'during races), 4 speed cameras and 2 speed traps with medals. Stage 1 dues completed: key remapping, controls card, rain with wet grip, near-miss nitro. '
    'More detailed sky, buildings and trees.',
    '<b>Round 5 - Fixes requested on 26 Nov:</b> lower memory use, softer rub / bump / crash collisions, toned-down police, clean driving under bridges, '
    'better night visibility without headlights.',
]))

add('<p class="label"><b>Deliverables:</b></p>')
add(items([
    'Fairbay Heat playable in the browser (desktop / keyboard), live on Vercel; every push to main deploys automatically.',
    'Public GitHub repository: TypeScript + Vite source, README with controls and features, roadmap (Stages 1-4 and Round 5 complete).',
    'Automated tests: 145 unit tests and 129 browser checks with real key presses, passing locally and on the live site at 60 fps (Apple M1).',
    '32 test screenshots in docs/screenshots and this progress report.',
]))

add('<p class="label"><b>Bug:</b></p>')
bugs = [
    ('Driving under bridges (fixed 26 Nov)',
     'From below, the viaduct deck was invisible (open sky between two floating beams); beside the street under it the car could jump up onto the highway or '
     'hit an invisible wall; the camera jerked in; columns could be driven through; cars on the deck could crash into cars below; rain fell through the deck.',
     'Deck underside now drawn, ground lookup ignores the deck above, camera no longer pulls in, columns are solid, contact is level-aware, rain stops under decks. '
     '6 new tests guard it.'),
    ('Every collision was a full crash (fixed 26 Nov)',
     'Light taps stopped or bounced the car back.',
     'Three strengths now: rub under 18 km/h, bump 18-45 km/h (traffic car is pushed along and drives on), crash only above 45 km/h, shared by mass; wall scrapes slide without bouncing.'),
    ('Police too strong (fixed 26 Nov)',
     'Units kept up, rammed head-on at 200+ km/h and tailgated into the player.',
     'Speed caps, safe tailing, short PITs that back off, no head-on rams, fewer units, roadblocks from heat 4 with a wider gap, longer bust, quicker escape. '
     'In tests a 150-180 km/h getaway now escapes at heats 1-3.'),
    ('Night too dark without headlights (fixed 26 Nov)',
     'The road was near-black away from the headlights (65-95% of the scene); the moon vanished after midnight; streets were almost black around 6 am.',
     'Brighter moonlight and sky, horizon glow, wider lamp pools, glowing lane lines: about 3-4x brighter at night (measured at 5 spots), near-black area down to 12-28%, while headlight glare stays under 5%.'),
    ('High memory use (fixed 26 Nov)',
     'City build data stayed in memory for the whole game.',
     'JavaScript heap 125 MB to 35 MB; page + graphics memory 920 MB to 759 MB (Retina 1320 MB to 888 MB); no growth over 5 rounds of play.'),
]
for title, problem, fix in bugs:
    add(f'<p class="bug"><b>{E(title)}</b></p><p class="pf"><b>Problem:</b> {E(problem)}</p><p class="pf"><b>Fix:</b> {E(fix)}</p>')
add('<p class="pf note">Earlier stages also fixed: cars pivoting about their centre (now turn about the rear axle), headlight glare washing out the screen (25-38% white to under 4%), '
    'a gear-shift hiss, overlapping traffic at one junction, rivals stuck at a sharp junction, and speed cameras counting one pass twice.</p>')
add('<p class="pf note">Not yet checked by a person: driving feel, race difficulty and the new sounds were measured by tests only. Not done: Stage 4 "more cars" (still 6 cars).</p>')

add('<p class="label"><b>Link:</b></p>')
add(f'<p class="field"><b>Live game:</b> <a href="{LIVE}">{LIVE}</a></p>')
add(f'<p class="field"><b>GitHub:</b> <a href="{REPO}">{REPO}</a></p>')

add('<div class="shots"><p class="label"><b>Screenshots:</b></p><div class="grid">'
    + fig('31-under-viaduct.png', 'Driving under the I-9 viaduct: the deck underside is now visible')
    + fig('22-pursuit.png', 'Police chase with the heat meter')
    + fig('26-race-countdown.png', 'Race countdown against AI rivals')
    + fig('16-night.png', 'Night downtown: lit shopfronts; headlights dim automatically facing a wall')
    + '</div></div>')

css = '''
@page{size:A4;margin:16mm 17mm 16mm 17mm}
body{font:10.5pt/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0}
h1{font-size:15pt;text-align:center;margin:6pt 0 18pt}
p{margin:0 0 6pt} .field{margin:0 0 7pt}
.label{margin:12pt 0 5pt;break-after:avoid}
.item{margin:0 0 4pt;padding-left:14pt;text-indent:-14pt}
.bug{margin:9pt 0 2pt;break-after:avoid} .pf{margin:0 0 2pt} .note{margin-top:8pt;color:#333}
a{color:#1155cc}
.shots{break-before:page}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10pt}
figure{margin:0;break-inside:avoid} figure img{width:100%;border:1px solid #ccc}
figcaption{font-size:8pt;color:#555;text-align:center;margin-top:2pt}
'''
out = HERE / f'{STEM}.html'
out.write_text(f'<!doctype html><html><head><meta charset="utf-8"><title>Fairbay Heat Progress Report 26-11-2026</title>'
               f'<style>{css}</style></head><body>{"".join(parts)}</body></html>', encoding='utf-8')
print('HTML:', out)
