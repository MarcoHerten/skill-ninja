# Skill Ninja

> Der Wärter für die Skills deines KI-Agenten – sieh, wo jeder Skill liegt, halte die Sammlung sauber und nimm neue Skills sicher auf, auch wenn sie nicht über [skills.sh](https://skills.sh) kommen.

*(English version: [README.md](./README.md))*

## Das Problem, in klaren Worten

KI-Coding-Agenten – Claude Code, Codex, Cursor, … – lernen ihre Tricks aus **Skills**: kleinen Anweisungsdateien, die ihnen ein Handwerk beibringen. Wie man eine Pressemitteilung schreibt. Wie man Code reviewt. Wie man einen Workshop plant.

Ein Skill ist ein Geschenk. Zwanzig sind ein Vollzeitjob:

- Sie verteilen sich über Agenten, Projektordner und Obsidian-Vaults – manche global, manche pro Projekt.
- Manche sind echte Kopien, manche nur Verweise (Symlinks). Links brechen lautlos.
- Zwei Versionen desselben Skills liegen nebeneinander, und nichts sagt dir, welche tatsächlich läuft.
- Ganze Skill-Pakete kommen als **Plugins** gebündelt daher – in Cache-Ordnern, in die keine Skills-Übersicht schaut.
- Ein Freund schickt dir „v2“ eines Skills. Was hat sich geändert? Das will niemand von Hand herausfinden.

Wer im Terminal zuhause ist, skriptet sich notfalls drum herum. Alle anderen managen das Chaos von Hand – oder geben auf. Skill Ninja existiert, damit das niemand muss.

## Was Skill Ninja tut

Skill Ninja läuft **in deinem Coding-Agenten**, als Slash-Commands, über den Skills, die [skills.sh](https://skills.sh) (oder du) bereits dorthin gelegt hat.

Kurz: **skills.sh installiert Skills. Skill Ninja passt auf sie auf.** Ein klares Bild deiner Landschaft, plus die Werkzeuge, um sie gesund zu halten:

- **`/ninja init`** – schaut auf deine Maschine: welche Agenten installiert sind, wo jeder Skill liegt – die losen wie die in Plugins gebündelten. Keine Vorbereitung nötig – die Konfiguration wird beim ersten Lauf für dich angelegt. Richtet außerdem deinen **Skill-Store** ein: ein normales, sichtbares Git-Repo unter `~/skill-ninja-store` (eigener Name oder Pfad: `init --store <name|pfad>`).
- **`/ninja status`** – das Inventar auf einem Bildschirm: welcher Agent welchen Skill erreicht, echte Kopie oder Link, global oder projektbezogen, Duplikate, tote Links, Versionen – und woher jeder Skill kommt. Auch in Agent-Plugins gebündelte Skills, mit dem Plugin, zu dem sie gehören.
- **`/ninja cat`** – dein Katalog: Skills nach Kategorie durchstöbern (jeder mit seiner Einzeiler-Beschreibung) oder nach einem Begriff filtern. `cat assign` sortiert einen unkategorisierten Skill ein. Kategorien leben im Frontmatter des Skills selbst, nie in einer handgepflegten Liste ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md)) – auch die Statusseite gruppiert nach Kategorie.
- **`/ninja page`** – dasselbe Inventar als Website: eine in sich geschlossene HTML-Datei unter `~/.skill-ninja/status.html`. Kein Server, keine externen Assets, kein Netzwerk. Seit v1.3 ein kleines Cockpit: Suche, Filter und Checkboxen, die einen kopierbaren `/ninja … --apply`-Befehl bauen – chat-fertig, direkt in den Agenten-Chat einfügen. Die Seite selbst führt nichts aus – die Engine bleibt hinter `--apply` ([ADR-0011](./docs/adr/0011-static-html-status-page.md)). Direkt hinter jedem Skillnamen sitzt ein `copy`-Knopf: Ein Klick legt den Skill-Namen in die Zwischenablage – das Token, das du in einen Chat oder ein Terminal einfügst, um den Skill dort aufzurufen.
- **`/ninja doctor`** – findet tote Links, Duplikat-Wildwuchs und verwaiste Kopien, und schlägt für jede eine Reparatur vor. Angefasst wird nichts ohne dein OK: mit `--apply` führst du die freigegebenen Fixes aus.
- **`/ninja add`** – ein Skill, der nicht über skills.sh kam (von einem Freund, aus einem Download oder als nackter Prompt-Text): Sicherheitscheck, Diff gegen das Vorhandene, Stempel mit Herkunft und Hash, ein lesbares `CHANGELOG.md` – und die Installation selbst.
- **`/ninja ingest`** – ein ganzes, unordentliches Verzeichnis auf einmal: ein Export, eine Prompt-Bibliothek, ein Ordner voller Fast-Duplikate. Alles wird klassifiziert, die Varianten gebündelt, ein Gewinner pro Cluster vorgeschlagen – mit Begründung. Zwillinge mit echten Unterschieden entscheidest du selbst; der Rest wandert in einem Commit in den Store. Der Quellordner bleibt unangetastet.
- **`/ninja on` / `off` / `manual`** – dein Hebel aufs Kontextfenster. `off` entlädt einen Skill überall. `manual` hält ihn einen Slash entfernt, stoppt aber das automatische Auslösen. `on` holt ihn zurück – und dient zugleich als Installation auf Abruf für Skills, die gespeichert, aber nicht verlinkt sind ([ADR-0014](./docs/adr/0014-availability-layer.md)).
- **`/ninja find`** – das Inventar durchsuchen: nach Name, Beschreibung oder Kategorie.
- **`/ninja profile`** – benannte Skill-Sets je Zweck („das Content-Setup“, „das Code-Setup“): Memberliste einmal speichern, in jedem Repo per `apply` aktivieren, beim Weiterziehen per `lift` wieder entfernen.
- **`/ninja collection`** – benannte persönliche Filter über die Landschaft („alles von Nils“), nutzbar in `cat`, `find`, im Dropdown der Seite und bei `on`/`off`/`manual` in Masse.
- **`/ninja diff`** – „Mein Freund hat v2 geschickt – was ist neu?“ Zeigt, was sich seit dem Einlagern wirklich geändert hat – oder gegen die skills.sh-Quelle.

### Wo deine Skills leben

Deine **persönlichen** Skills leben an einem sichtbaren Ort: dem **Skill-Store**, einem normalen Git-Repository in deinem Home-Verzeichnis (standardmäßig `~/skill-ninja-store`). Du kannst es öffnen, lesen, seine Historie durchstöbern. Schiebe es in ein privates GitHub-Repo – schon hast du Backup außerhalb der Maschine plus ein Änderungsprotokoll pro Skill: jede Skill-Ninja-Aktion landet als Commit, der die Frage beantwortet: „Was hat sich an diesem Skill geändert – und wann?“

Über skills.sh installierte Skills bleiben Eigentum von skills.sh – Skill Ninja passt auch auf sie auf, verlinkt sie nur nicht neu. Und in Agent-**Plugins** gebündelte Skills bleiben Eigentum des Plugin-Systems – inventarisiert wie alles andere, nie angefasst.

## Bereit für Agent Plugins

Agenten lesen nicht nur lose Skills – sie lesen **Plugins**, und Plugins bringen eigene Skills mit. [Agent Plugins 1.0.0](https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/) – die offene Packaging-Spezifikation von **Amazon**, **Cursor**, **Microsoft**, **OpenAI** und **Vercel**, seit 2026 mit **Google** – standardisiert so ein Bündel: ein Verzeichnis mit `plugin.json`-Manifest, die Skills in `skills/`, Werkzeuge und Client-Erweiterungen daneben.

Skill Ninja ist darauf vorbereitet ([ADR-0018](./docs/adr/0018-plugin-owned-skills.md)):

- **Plugin-gebündelte Skills erscheinen in deinem Inventar.** `status`, `page`, `cat` und `find` zeigen sie mit dem Plugin, zu dem sie gehören – „wo jeder Skill lebt“ schließt den Plugin-Kanal ein. Das Layout wird unverändert erkannt: Ein Plugin im Agent-Plugins-1.0.0-Format wird heute schon entdeckt und seinem Manifest-Namen zugeordnet.
- **In einem Plugin wird nie etwas angefasst.** Plugins sind Sache des Plugin-Systems deines Agenten – Skill Ninja auditiert sie wie skills.sh-Installationen: keine Reparaturen, keine neuen Links, keine Availability-Schalter. (Hält ein Plugin mehrere Versionen desselben Skills im Cache, ist das die Verwaltung des Plugin-Managers – nicht dein Duplikat.)

Die Plugin-Roots decken aktuell die Caches von Claude Code (`~/.claude/plugins/cache`) und ZCode (`~/.zcode/cli/plugins/cache`) ab – die Spezifikation definiert bewusst keinen Installationsort, die Karte wächst mit den Clients, die das Format übernehmen.

## Schnellstart

Das ganze Produkt läuft als Slash-Commands in deinem Coding-Agenten. Das ist der gedachte Workflow – von der Installation bis zur sauberen, versionierten Skill-Landschaft in wenigen Minuten:

```
Installieren (einmal, global)
   │
   ▼
npx skills add -g MarcoHerten/skill-ninja       – Skill Ninja kommt als globaler Skill an
   │
   ▼
/ninja init                                      – legt Konfiguration + Skill-Store an
   │
   ▼
/ninja status  ·  /ninja page                    – die ganze Landschaft auf einen Blick
   │
   ├─► /ninja doctor --apply                     – tote Links und Duplikate reparieren
   ├─► git remote add … + push                   – privates Backup + blätterbare Historie
   │
   ▼
/ninja add  ·  /ninja ingest  ·  /ninja diff     – Alltag
```

### 1. Installieren (einmal, global)

Die beiden `npx`-Befehle in diesem README laufen im **Terminal**. Noch keins offen?

- **Mac:** `⌘ + Leertaste` drücken, `Terminal` eintippen, Enter – oder unter *Dienstprogramme* nachsehen.
- **Windows:** `Windows`-Taste drücken, `Terminal` (oder `PowerShell`) eintippen, Enter.

Einzige Voraussetzung: [Node.js](https://nodejs.org) – `npx` kommt mit.

```bash
npx skills add -g MarcoHerten/skill-ninja
```

Das `-g` macht Skill Ninja zu einem **globalen Skill** (auf Benutzerebene) – skills.sh installiert standardmäßig projektbezogen, und Skill Ninja ist der eine Skill, den du überall willst: `/ninja` funktioniert damit in jedem Projekt und wacht über die ganze Maschine, nicht über ein einzelnes Repo. Und ja – Skill Ninja ist selbst ein Skill. Es kommt durch dieselbe Tür, die es später bewacht.

### 2. Bestandsaufnahme: erst `init`, dann `status`

```
/ninja init
/ninja status
```

`init` braucht keine Vorbereitung. Es entdeckt, welche Coding-Agenten auf deiner Maschine leben, findet jeden Skill über Agenten-Roots, Obsidian-Vaults und Projektverzeichnisse hinweg und richtet die Konfiguration (`~/.skill-ninja/config.json`) plus deinen Skill-Store ein – mit README und erstem Commit als Startausstattung, damit er vom ersten Push an präsentabel ist. Beim ersten Lauf schlägt dein Agent den Standardnamen vor und fragt, ob du einen eigenen möchtest (ein schlichter Name wie `my-skills` oder ein Pfad wie `~/code/skill-store`, via `init --store`). Ein erneutes `init` benennt einen bestehenden Store niemals um und verschiebt ihn nicht.

`status` zeigt danach die ganze Landschaft – Duplikate, tote Symlinks, Versionen, Herkünfte. Starte ihn neu, wann immer sich etwas ändert; Filter wie `/ninja status --duplicates` grenzen die Ansicht ein.

Lieber im Browser? `/ninja page` schreibt dieselbe Ansicht als in sich geschlossene HTML-Datei und sagt dir, wo sie liegt.

**Halte die Statusseite griffbereit:** sie liegt unter `~/.skill-ninja/status.html`, und `page` schreibt diese Datei bei jedem Lauf neu. Ein Symlink an einem sichtbaren Ort wird daher nie stale:

```bash
ln -s ~/.skill-ninja/status.html ~/Desktop/skill-ninja-status.html
```

### 3. Aufräumen: `doctor`

```
/ninja doctor
```

Findet tote Links, Duplikat-Wildwuchs und verwaiste Kopien – jeweils mit Reparaturvorschlag. Alles wartet auf dein OK: mit `--apply` führst du die abgenickten Fixes aus.

### 4. Versionierung einschalten (empfohlen, einmal)

Jeder Skill, den Skill Ninja einlagert, wird ins Store-Repo committet. Für Backup außerhalb der Maschine und eine durchblätterbare Historie: lege ein **privates** GitHub-Repo an und verbinde es:

```bash
git -C ~/skill-ninja-store remote add origin git@github.com:<du>/skill-ninja-store.git
```

Das ist das gedachte Setup: **ein sichtbares Repo, gepusht in ein privates Remote** – `add`, `ingest --apply`, `cat assign` und Availability-Schalter landen alle als Commits. Das Log beantwortet: „Was hat sich an diesem Skill geändert – und wann?“

Halte das Repo privat – persönliche Skills tragen oft Firmenkontext. Kein Remote? Skill Ninja committet trotzdem lokal und überspringt das Pushen still.

### 5. Im Alltag: ein Skill kommt an → `add`

```
/ninja add <folder|file|zip|repo>
```

Der kuratierte Weg für einen einzelnen Skill, der nicht über skills.sh kam: Sicherheitscheck, Diff gegen eine gespeicherte Version, Stempel mit Herkunft und Content-Hash, Verlinkung in deine Agenten-Roots, Commit + Push. Nackter Prompt-Text geht auch (`--prompt`), und `--from` hält fest, wer ihn geschickt hat.

### 6. Ein ganzes, unordentliches Verzeichnis → `ingest`

```
/ninja ingest ~/Downloads/skills-export
```

Der Weg für die Masse. Der Export, der denselben Skill als Ordner, als `.zip`, als `.skill` *und* als `.skill.zip` enthält. Die Prompt-Bibliothek, die nie Skills waren. Der Probelauf klassifiziert jedes Element, bündelt die Varianten und berichtet den Vorschlag: ein Gewinner pro Cluster mit Begründung, Verlierer mit Content-Hashes, Müll, eine Sicherheits-Spalte und Side-by-Sides für die widersprüchlichen Duplikate, die keine Regel lösen kann. Du gehst den Bericht durch und entscheidest die Konflikte; `--apply` lagert den Rest in einem Commit ein (gepusht, wenn ein Remote verbunden ist). Braucht eine Gruppe deine Entscheidung, wird sie übersprungen – nie automatisch entschieden. Das Quellverzeichnis wird nie verändert, und nichts wird automatisch in deine Agenten verlinkt – halte deinen Kontext schlank und verlinke bewusst über `add`.

### 7. Etwas hat sich geändert → `diff`

```
/ninja diff <name> <candidate>
```

Der Vergleich läuft über den Skill-Body – Buchhaltungsrauschen wie Stempel und Hashes taucht nie als „Änderung“ auf.

### Faustregel

| Situation | Befehl |
| --- | --- |
| Skill kam über skills.sh | mit `npx skills` verwalten – Skill Ninja prüft ihn, verlinkt ihn aber nicht neu |
| Ein neuer Skill von Freund, Download oder Prompt | `/ninja add` |
| Ein ganzer Export / eine Prompt-Bibliothek | `/ninja ingest` |
| „Welche meiner Skills sind Marketing-Skills?“ | `/ninja cat` (dann `cat assign` für die unkategorisierten) |
| „Welche Skills passen zu \<begriff\>?“ | `/ninja find <begriff>` |
| „Dieser Skill triggert dauernd, ich will ihn auf Abruf“ | `/ninja manual <name>` (per Name aufrufbar, nie automatisch) |
| „Raus aus meinem Kontextfenster, ganz“ | `/ninja off <name>` (oder `off --category "…"` in Masse) |
| „Dieses Repo braucht meine Content-Skills“ | `/ninja profile save content <namen…>`, dann `profile apply content` im Repo |
| „Zeig mir Nils’ Skills als Bündel“ | `/ninja collection save nils <namen/präfixe…>`, dann `cat @nils` |
| Landschaft fühlt sich falsch an | `/ninja status`, dann `/ninja doctor` |
| Ein aktualisiertes Exemplar eines gespeicherten Skills taucht auf | `/ninja diff`, dann `/ninja add` |

## Status

🚧 **Früh – und alles darunter ist live, bis einschließlich v1.6.**

- **v1.0** – `init` (Bootstrap + Scan), `status`, `doctor`, `add` (Sicherheitscheck, Stempel, Commit + Push), `diff`
- **v1.1** – die `ingest`-Massenpipeline ([ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)); die Offline-Statusseite `page` ([ADR-0011](./docs/adr/0011-static-html-status-page.md))
- **v1.2** – der Kategorie-Katalog: `cat`, `cat assign`, Kategorie-Gruppierung in Status und Seite ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md))
- **v1.3** – die Availability-Schicht: `on`/`off`/`manual` mit einheitlichen Selektoren und Two-Phase-Apply, `find`, `profile`, Inventar v4, das Cockpit der Seite ([ADR-0014](./docs/adr/0014-availability-layer.md))
- **v1.3.1** – Collections als persönliche Filter für `cat`/`find`/Seite/`--collection` ([ADR-0015](./docs/adr/0015-collections-are-config-side.md))
- **v1.4** – der sichtbare kanonische Store: `~/skill-ninja-store` als Standard, `init --store`, README + erster Commit als Startausstattung ([ADR-0016](./docs/adr/0016-visible-canonical-store.md))
- **v1.5** – reisende Bündel: Collections & Profiles leben store-seitig (`<store>/collections.json` / `profiles.json`), reisen mit dem Store-Repo und kehren auf einer neuen Maschine zurück – Store klonen + `init` ([ADR-0017](./docs/adr/0017-collections-and-profiles-travel-with-the-store.md))
- **v1.6** – Plugin-Bewusstsein: in Agent-Plugins gebündelte Skills (Agent-Plugins-1.0.0-Layout und die Vor-Spezifikations-Caches) werden als plugin-owned inventarisiert – überall sichtbar, nirgends angefasst ([ADR-0018](./docs/adr/0018-plugin-owned-skills.md))

Aufgerufen wird der Skill als `/ninja` (z. B. `/ninja init`). Mehr Details: [`SPEC.md`](./SPEC.md), [`CONTEXT.md`](./CONTEXT.md) und [`docs/adr/`](./docs/adr).

## Installation

```bash
npx skills add -g MarcoHerten/skill-ninja
```

Das Flag `-g` installiert Skill Ninja **global** (auf Benutzerebene), sodass `/ninja` in jedem Projekt funktioniert – das ist die empfohlene Einrichtung. Lass es weg, wenn du Skill Ninja bewusst auf ein einzelnes Repo beschränken willst – das ist der skills.sh-Standard. Vertrieb über [skills.sh](https://skills.sh) (`npx skills`) – Multi-Agent-Targeting und hash-basierte Updates gibt es gratis dazu. Dieselbe Routine installiert die Skills, um die sich Skill Ninja danach kümmert.

## Update

Skill Ninja aktualisiert sich nie selbst – Updates sind die Aufgabe von [skills.sh](https://skills.sh), genau wie die Installation. Frische alle über skills.sh installierten Skills auf (Skill Ninja inklusive) mit:

```bash
npx skills update
```

Das Update ist hash-basiert: nur Skills, deren Inhalt sich wirklich geändert hat, werden neu geschrieben. Bei einer globalen Installation führst du es außerhalb jedes Projektverzeichnisses aus (oder mit `-g`); bei einer projektbezogenen im jeweiligen Projektverzeichnis. Danach `/ninja init` – damit das zwischengespeicherte Inventar (und mit ihm `/ninja status` und `/ninja page`) die neuen Versionen zeigt: Skill Ninja trägt eigene `version`/`updated`-Stempel im `SKILL.md`-Frontmatter, bei jedem Release neu gesetzt.

## Roadmap

- **v1.0** ✅ – `init`, `status`, `doctor`, `add` (+ Sicherheitscheck), `diff`
- **v1.1** ✅ – `ingest` (Massen-Pipeline für unordentliche Skill-/Prompt-Verzeichnisse – [ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)); statische HTML-Statusseite ([ADR-0011](./docs/adr/0011-static-html-status-page.md))
- **v1.2** ✅ – Kategorie-Katalog: `cat` gruppiert die Landschaft, `cat assign` stempelt Kategorien ins Skill-Frontmatter ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md))
- **v1.3** ✅ – Availability-Schicht: `on`/`off`/`manual`, `find`, `profile`, Inventar v4, das Cockpit der Seite ([ADR-0014](./docs/adr/0014-availability-layer.md))
- **v1.3.1** ✅ – Collections: persönliche Filter für `cat`/`find`/Seite/`--collection` ([ADR-0015](./docs/adr/0015-collections-are-config-side.md))
- **v1.4** ✅ – sichtbarer kanonischer Store: `~/skill-ninja-store` als Standard, `init --store <name|pfad>`, README + erster Commit ([ADR-0016](./docs/adr/0016-visible-canonical-store.md))
- **v1.5** ✅ – reisende Bündel: Collections & Profiles ziehen store-seitig um (`<store>/collections.json` / `profiles.json`), werden mit dem Store committet und auf einer neuen Maschine per Klon + `init` wiederhergestellt ([ADR-0017](./docs/adr/0017-collections-and-profiles-travel-with-the-store.md))
- **v1.6** ✅ – Plugin-Bewusstsein: Agent-Plugin-Caches werden zu Scan-Roots, gebündelte Skills werden als plugin-owned auditiert (Agent-Plugins-1.0.0-ready) ([ADR-0018](./docs/adr/0018-plugin-owned-skills.md))

## Designprinzipien

- **Local-first** – deine Skills bleiben auf deiner Maschine; das einzige Netzwerk ist das optionale Git-Remote.
- **Eine Quelle der Wahrheit pro Ebene** – ein kanonischer Store für persönliche Skills (in jeden Agenten-Root verlinkt), das Lockfile von skills.sh für die von ihm installierten Skills und das Plugin-System des Agenten für plugin-gebündelte Skills. Skill Ninja prüft über alle drei hinweg.
- **Agent-nativ** – bedient über Slash-Commands in deinem Coding-Agenten, nicht über eine separate App.
- **Sicher von Haus aus** – ein leichter Sicherheitscheck bei jedem eingehenden Skill, und Massenaktionen bleiben Probeläufe, bis du `--apply` übergibst.

## Lizenz

MIT
