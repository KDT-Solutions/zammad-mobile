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

Docker Compose (z.B. als Portainer-Stack), siehe `docker-compose.yml`. Der Container lädt beim Start den Code aus dem Repository.

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `ZAMMAD_URL` | ja | Interne Adresse von Zammad, z.B. `http://10.0.0.5:8080` |
| `ZAMMAD_HOST_HEADER` | nein | Host-Header für Zammad, z.B. `support.example.com` |
| `PUBLIC_URL` | ja | Öffentliche URL inkl. Pfad, z.B. `https://support.example.com/mobilenew` |
| `APP_SECRET` | ja | Mindestens 32 zufällige Zeichen, verschlüsselt die gespeicherten Tokens |
| `BASE_PATH` | nein | Pfad der App, Standard `/mobilenew` |
| `ALLOWED_LOGINS` | nein | Kommagetrennte Logins/E-Mails, die sich anmelden dürfen (leer = alle Agents) |
| `POLL_SECONDS` | nein | Abfrage-Intervall für Benachrichtigungen, Standard 15 |
| `VAPID_SUBJECT` | nein | `mailto:` oder `https:`-Kontakt für die Push-Dienste, Standard ist der Ursprung von `PUBLIC_URL` |
| `GITHUB_REPO`, `GITHUB_REF` | ja / nein | Quelle des Codes, z.B. `owner/zammad-mobile`, Standard-Branch `main` |
| `BIND_ADDR`, `HOST_PORT` | nein | Host-Adresse und -Port der Veröffentlichung |

VAPID-Schlüssel und Datenbank liegen im Volume und werden beim ersten Start erzeugt.

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
