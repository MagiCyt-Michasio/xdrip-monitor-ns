# xDrip Monitor NS

Niezależna wersja xDrip Monitor korzystająca bezpośrednio z MongoDB Nightscout. Stare repozytorium `xdrip-backup` nie jest modyfikowane.

## Co zawiera
- Dotychczasowy interfejs monitora w `public/index.html`.
- Backend Express w `server.js`.
- Odczyt glukozy z `nightscout.entries` (dokumenty `type: "sgv"`).
- Odczyt insuliny i węglowodanów z `nightscout.treatments`.
- Obsługa `timestamp` (ms) oraz `created_at` (ISO).
- Deduplikacja znanej pary `LibreView CSV import` / `Bolus (Odzyskany)` tylko w odpowiedzi API — bez modyfikowania bazy.
- Ręczne wpisy oznaczane `notes: "xdrip-monitor-ns:manual"`.
- Usuwanie wyłącznie własnych ręcznych wpisów po MongoDB ObjectId.
- Endpoint kontrolny `/health`.

## Instalacja na Debianie
```bash
git clone https://github.com/MagiCyt-Michasio/xdrip-monitor-ns.git
cd xdrip-monitor-ns
npm install
cp .env.example .env
nano .env
npm start
```

W `.env` ustaw `MONGODB_URI` z loginem i hasłem użytkownika MongoDB, pozostaw `MONGODB_DB=nightscout` i wybierz port `PORT=3050`. Nie publikuj pliku `.env`.

Panel: `http://ADRES_SERWERA:3050/dane`
Kontrola: `http://ADRES_SERWERA:3050/health`

## Test obok starej wersji
Jeśli stary monitor zajmuje port 3050, nie zatrzymuj go. Do pierwszego testu ustaw w nowym `.env` `PORT=3057`.

## Bezpieczeństwo
- Projekt czyta bazę `nightscout`, nie starą bazę `dane`.
- Nie wykonuje migracji ani masowego usuwania dokumentów.
- Deduplikacja jest wyłącznie po stronie API.
- Usuwanie wymaga dokładnego tagu własnego wpisu monitora.
