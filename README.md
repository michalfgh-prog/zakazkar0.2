# Zakázkář — sloučená aplikace

Desktopová i mobilní aplikace byly sloučeny do **jedné responzivní webové aplikace** bez landing page, pouze se skutečným přihlášením. Funguje na mobilu, tabletu i desktopu.

## Struktura repozitáře

```
zakazkar/
├── server.js # Node.js server (API + sken + web)
├── index.html # celá sloučená aplikace (jediná stránka)
├── package.json
├── data/
│ └── online-data.json # výchozí uživatelé a příspěvky (seed)
└── README.md
```

## Co aplikace umí

- **Přihlášení / registrace** — skutečné účty na serveru (první registrovaný účet = správce)
- **Přehled** — statistiky, nejnovější zakázky, průběh obchodu, galerie vlastních fotek (uložené v prohlížeči)
- **Zakázky** — sken 22 poptávkových portálů (MSK), filtry (Vše / Nové / Oblíbené / Pipeline), hledání, export CSV, reset paměti
- **Mini-CRM** — u každé zakázky stav (Nová → Kontaktováno → Nabídka → Vyhráno/Ztraceno) a poznámka
- **Oblíbené** — hvězdičkou označené zakázky
- **Chat** — soukromé zprávy mezi uživateli, indikace online, nepřečtené zprávy
- **Naše tipy** — komunitní feed: příspěvky s fotkou, lajky, komentáře, sdílení
- **Klíčová slova** — co má sken hledat
- **Portály** — výběr prohledávaných zdrojů
- **Nastavení** — účet, tmavý/světlý režim, automatický sken, odhlášení

## Spuštění lokálně

```bash
npm install
npm start
# otevřete http://localhost:8766/
```

Bez proměnné `DATABASE_URL` se účty, zprávy a příspěvky ukládají do `data/online-data.json`.

## Nasazení na Render.com přes GitHub

1. **Vytvořte repozitář na GitHubu** (např. `zakazkar`) a nahrajte do něj všechny soubory výše uvedené struktury.
- Pozor: `data/online-data.json` obsahuje vaše účty (hesla jsou zahashovaná) a příspěvky. Pokud bude repozitář veřejný, zvažte, zda soubor do repozitáře dáte.
2. Na **render.com** → *New → PostgreSQL* — vytvořte databázi a zkopírujte její *Internal Database URL*.
3. Na **render.com** → *New → Web Service*:
- **Repository:** vyberte váš GitHub repozitář
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** přidejte proměnnou `DATABASE_URL` = interní URL databáze z kroku 2
4. Render nasadí aplikaci na `https://nazev-appi.onrender.com`.

### Poznámky k Render

- **Databáze je doporučená.** Disk na Renderu je při každém nasazení smazán — bez `DATABASE_URL` by se účty pokaždé ztratily.
- Při prvním startu s `DATABASE_URL` server automaticky vytvoří tabulky a převezme uživatele, relace, zprávy a příspěvky ze souboru `data/online-data.json`.
- `PORT` Render nastavuje sám — server ho používá automaticky.
- Sken portálů běží přes veřejnou „čtečku“ stránek; některé portály občas neodpoví — je to uvedeno ve stavu skenu v aplikaci.
- Staré adresy (`/mobilni-zakazkar.html`, `/zakazkar-vylepsena.html`) jsou přesměrovány na `/`, takže existující odkazy zůstanou funkční.

## Změny oproti původním aplikacím
```
| Oblast                    | Původ                                  | Sloučená verze                                                        |
| ------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| UI                        | 2 samostatné stránky (desktop + mobil) | 1 responzivní stránka                                                 |
| Landing page a demo režim | ano (desktop)                          | odebrány — jen skutečné přihlášení                                    |
| Tarify / fakturace        | ukázkové (desktop)                     | odebrány — vše bez omezení                                            |
| Server                    | obsluhoval obě stránky                 | slouží `index.html` na `/`, staré adresy přesměruje                   |
| API                       | shodné                                 | beze změny (`/api/scan`, `/api/auth/*`, `/api/chat/*`, `/api/feed/*`) |
```
