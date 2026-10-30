# zammad-mobile

Schlanke mobile Oberfläche für Zammad-Agents als PWA, mit nativen Push-Benachrichtigungen (Web Push) auf iOS und Android.

- Ticketlisten aus den eigenen Zammad-Übersichten, Suche, Benachrichtigungsliste
- Ticket öffnen, direkt antworten (E-Mail mit Gruppensignatur, WhatsApp, SMS, Telegram je nach letztem Kundenkanal), interne Notiz, Anhänge
- Ein Tipp für „Senden & schliessen“, dazu Schliessen, Wieder öffnen, Mir zuweisen, Warten bis, Status setzen
- Push-Meldungen für alles, was Zammad dem Benutzer als Online-Benachrichtigung zustellt (neue Tickets, Antworten, Erinnerungen, Eskalationen); welche Ereignisse das sind, steuert jeder Agent wie gewohnt in Zammad unter Profil > Benachrichtigungen. Pro Gerät ein-/ausschaltbar, Ereignistypen filterbar.

## Funktionsweise

```
Browser/PWA  ──HTTPS──>  Reverse-Proxy  ──/mobilenew/──>  zammad-mobile (Node)  ──REST──>  Zammad
                                                              │
                                                              └── Web Push (VAPID) ──> Apple/Google Push-Dienst ──> Gerät
```

- **Login** mit den eigenen Zammad-Zugangsdaten. Der Server prüft sie gegen Zammad, lässt sich einen persönlichen API-Token ausstellen (`ticket.agent`) und speichert nur diesen, AES-256-GCM-verschlüsselt. Das Passwort wird nicht gespeichert. Beim Abmelden auf dem letzten Gerät wird der Token in Zammad widerrufen.
- Bei aktiver Zwei-Faktor-Anmeldung oder gesperrtem Passwort-Zugriff auf die API: in Zammad unter *Profil > Token-Zugriff* einen Token mit `ticket.agent` erstellen und sich damit anmelden.
- Alle Zammad-Aufrufe laufen über den Server (`/api/z/...`); der Browser sieht den Token nie. Sitzungen per HttpOnly/Secure-Cookie, CSRF-Schutz über einen eigenen Header, Login-Rate-Limit, strikte CSP. E-Mail-HTML wird mit DOMPurify bereinigt, externe Bilder (Tracking) werden blockiert.
- **Push**: Der Server fragt für jeden Benutzer mit aktivem Push-Abo alle `POLL_SECONDS` die Zammad-Online-Benachrichtigungen ab und schickt neue als Web Push. Mehrere Meldungen zum selben Ticket werden zusammengefasst.

Auf dem iPhone kommen Pushes nur, wenn die App über Safari > Teilen > „Zum Home-Bildschirm“ installiert und von dort geöffnet wurde (iOS 16.4 oder neuer).

## Betrieb

Docker Compose (z.B. als Portainer-Stack), siehe `docker-compose.yml`. Der Container lädt beim Start den Code aus dem Repository (Tarball von `GITHUB_REF`), installiert die Abhängigkeiten mit `npm ci` und startet. Das Basis-Image ist auf einen festen Digest gepinnt.

**Achtung:** `GITHUB_REF=main` (Standard) bedeutet Auto-Deploy: jeder Neustart des Containers führt ungeprüft den aktuellen Stand von `main` aus, inklusive Zugriff auf `APP_SECRET` und alle gespeicherten Agent-Tokens. Für den produktiven Betrieb `GITHUB_REF` auf einen Release-Tag oder Commit-SHA setzen, siehe [Release-Tag setzen](#release-tag-setzen).

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `ZAMMAD_URL` | ja | Interne Adresse von Zammad, z.B. `http://10.0.0.5:8080` |
| `ZAMMAD_HOST_HEADER` | nein | Host-Header für Zammad, z.B. `support.example.com` |
| `PUBLIC_URL` | ja | Öffentliche URL inkl. Pfad, z.B. `https://support.example.com/mobilenew` |
| `APP_SECRET` | ja | Mindestens 32 zufällige Zeichen, verschlüsselt die gespeicherten Tokens |
| `BASE_PATH` | nein | Pfad der App, Standard `/mobilenew` |
| `ALLOWED_LOGINS` | nein | Kommagetrennte Logins/E-Mails, die sich anmelden dürfen (leer = alle Agents) |
| `POLL_SECONDS` | nein | Abfrage-Intervall für Benachrichtigungen, Standard 15 |
| `PUSH_IGNORE_USER_IDS` | nein | Kommagetrennte Zammad-User-IDs, deren Änderungen keinen Push auslösen (z.B. Automations- oder MCP-Benutzer) |
| `VAPID_SUBJECT` | nein | `mailto:` oder `https:`-Kontakt für die Push-Dienste, Standard ist der Ursprung von `PUBLIC_URL` |
| `GITHUB_REPO`, `GITHUB_REF` | ja / nein | Quelle des Codes, z.B. `owner/zammad-mobile`; `GITHUB_REF` ist Branch, Tag oder Commit-SHA, Standard `main` (= Auto-Deploy bei jedem Neustart, produktiv einen Tag oder SHA pinnen) |
| `BIND_ADDR`, `HOST_PORT` | nein | Host-Adresse und -Port der Veröffentlichung |

VAPID-Schlüssel und Datenbank liegen im Volume und werden beim ersten Start erzeugt.

### Release-Tag setzen

Ein Release ist ein annotierter Git-Tag auf dem gewünschten Commit, Name `v<Version aus package.json>`:

```sh
git checkout main && git pull
git tag -a v1.1.6 -m "Release 1.1.6"
git push origin v1.1.6
```

Danach im Stack `GITHUB_REF=v1.1.6` (oder den vollständigen Commit-SHA) setzen und den Container neu starten. Bei einem gepinnten Tag ändert ein Neustart nichts mehr am Code; ein Update ist dann immer ein bewusster Schritt (neuer Tag, `GITHUB_REF` anpassen, Neustart). Zum Rollback einfach `GITHUB_REF` auf den vorherigen Tag zurücksetzen.

Das Basis-Image in `docker-compose.yml` ist per Digest gepinnt (`node:<version>-alpine@sha256:…`). Zum Aktualisieren den Digest des neuen Tags von Docker Hub übernehmen und im Stack eintragen.

### Reverse-Proxy (Nginx Proxy Manager)

Die App läuft unter einem Pfad auf derselben Domain wie Zammad. Im Proxy-Host von Zammad unter *Advanced*:

```nginx
location = /mobilenew { return 301 /mobilenew/; }
location ^~ /mobilenew/ {
    proxy_pass http://<docker-host>:<port>;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    client_max_body_size 30m;
}
```

`^~` ist nötig, damit die Asset-Regeln des Proxy-Caches die App-Dateien nicht an Zammad weiterreichen.

## Entwicklung

```sh
npm install
npm test          # Integrationstests gegen einen Zammad-Mock
```
