# Offline Photo Timesheet (iPhone PWA)

This is an installable offline-first timesheet web app designed for iPhone.

## What it does
- Take/select work photos; selecting the first photo automatically starts the timer.
- Add editable title, description, location, GPS coordinates, machinery/equipment, date, start/finish times, breaks and optional manual total-hour override.
- Save everything locally in IndexedDB on the phone.
- Edit or delete old entries.
- Works offline after the first successful load/install.
- Weekly Monday-Friday timesheet in an A4 landscape layout similar to the supplied example.
- Every weekly sheet cell is editable before printing.
- Print from iPhone or save as PDF.
- Export/import a JSON backup, including photos.

## Important iPhone note
A PWA must be served over HTTPS for installation and service-worker offline caching. You need internet once to open/install it. After that, normal use can be fully offline.

## Install on iPhone
1. Upload this folder to any HTTPS static host (GitHub Pages, Cloudflare Pages, Netlify, etc.).
2. Open the HTTPS address in Safari on the iPhone while online.
3. Tap Share > Add to Home Screen.
4. Open the new Timesheet icon once while still online so all app files are cached.
5. After that you can use the app offline.

## Location
"Use current GPS" uses the iPhone's geolocation permission and stores latitude/longitude. GPS can work without internet. Turning coordinates into a street address normally requires an online map/geocoding service, so the location-name field remains manually editable.

## Printing / PDF
Open Weekly sheet > choose the week > make any edits directly in the table > Save sheet edits > Print / Save PDF.
On iPhone, the system Print screen can be used to save/share a PDF.

## Data/storage warning
The data lives on the device/browser. iOS can remove website data in some situations. Use Export backup regularly if the records are important.
