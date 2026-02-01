Alles klar – das ist ein **sehr sauberes Round-Trip-Szenario** 👍
Und: **Ja, das ist mit VS-Code-Extensions sehr gut machbar**, ohne Hacks.

Ich strukturiere die Antwort so, dass sie direkt zu deiner bestehenden Extension passt.

---

## Zielbild (kurz zusammengefasst)

Du hast aktuell:

```
DSL  ──▶ Java-Skeleton + @prompt
             │
             ▼
        LLM generiert
        Methodenrumpf
```

Neu soll gelten:

```
DSL  ──▶ Java-Skeleton + @prompt
             │
             ▼
        LLM generiert Methodenrumpf
             │
   (User bestätigt / editiert)
             │
             ▼
   Methodenrumpf zurück in DSL
   (als Implementierung)
```

👉 Beim nächsten Generieren:

* **keine LLM-Abfrage**
* stattdessen **Übernahme aus der DSL**

Das ist **klassisches Synchronisationsproblem**, aber in deinem Kontext gut beherrschbar.

---

## Zentrale Designentscheidung (wichtig!)

**Wo genau speicherst du die Implementierung in der DSL?**

Es gibt drei praktikable Varianten:

### ✅ Variante A (empfohlen): Implementation-Block in der DSL

```dsl
method foo(a: int): int {
    @impl {
        return a * 2;
    }
}
```

Vorteile:

* DSL bleibt „Single Source of Truth“
* sehr gut maschinell lesbar
* robust bei Re-Generierung

---

### Variante B: Inline-Annotation in der DSL

```dsl
method foo(a: int): int
@java {
    return a * 2;
}
```

Gut, wenn deine DSL ohnehin annotationsartig ist.

---

### Variante C (nicht empfohlen): Kommentar-basierter Hack

```dsl
// BEGIN JAVA foo
// return a * 2;
// END JAVA
```

❌ schwer robust zu parsen
❌ fehleranfällig

➡️ Ich gehe im Folgenden von **Variante A oder B** aus.

---

## Technischer Kern: Rückpropagieren aus Java nach DSL

### 1. Auslöser im Editor

Der Benutzer:

* steht **im Java-Methodenrumpf**
* oder markiert den Methodenrumpf
* oder klickt „Übernehme Implementierung in DSL“

➡️ **VS-Code Command**

```json
"command": "moproco.propagateImplementation"
```

---

## 2. Identifikation der Methode (entscheidend!)

Du brauchst:

* Klassenname
* Methodenname
* Signatur (Parameter-Typen!)
* Implementierungsblock

### Minimal-robuste Lösung (praxisnah)

Da du den Code **selbst generierst**, hast du Vorteile.

Beispiel:

```java
/**
 * @prompt multiply input by two
 * @dsl-id Foo.foo(int)
 */
public int foo(int a) {
    return a * 2;
}
```

👉 **Empfehlung:**
Füge beim Generieren **eine stabile DSL-ID** hinzu.

### Warum?

* Kein Java-Parser nötig
* Keine Heuristiken
* 100 % eindeutig

---

## 3. Methodenrumpf extrahieren

```ts
const editor = vscode.window.activeTextEditor!;
const document = editor.document;

// z. B. aktuelle Methode bestimmen
const selection = editor.selection;
const methodBody = document.getText(selection);
```

Oder robuster:

* finde `{ … }` nach Methodensignatur
* das machst du ja bereits bei `@prompt`

---

## 4. Ziel-DSL-Datei finden

Mehrere Optionen:

### Einfach:

* Java ↔ DSL Namenskonvention

  ```
  Foo.dsl  <-> Foo.java
  ```

### Robuster:

* Mapping beim Generieren speichern
* oder im JavaDoc:

  ```java
  @dsl-file model/Foo.dsl
  ```

Dann:

```ts
const dslUri = vscode.Uri.joinPath(
  workspaceFolder.uri,
  'model/Foo.dsl'
);
```

---

## 5. DSL-Datei lesen & gezielt aktualisieren

```ts
const content = await vscode.workspace.fs.readFile(dslUri);
let dslText = new TextDecoder().decode(content);
```

### Jetzt kommt der entscheidende Teil:

👉 **Nicht alles neu schreiben**, sondern:

* finde `method foo(...)`
* ersetze oder erzeuge den `@impl` / `@java` Block

Beispiel (vereinfachtes Regex):

```ts
dslText = dslText.replace(
  /method foo\(.*?\)\s*\{[\s\S]*?\}/,
  `method foo(a: int): int {
      @impl {
${methodBody}
      }
  }`
);
```

💡 Für Produktivbetrieb:

* besser ein **kleiner DSL-Parser**
* oder Marker-Kommentare:

  ```
  // @impl-start foo
  // @impl-end foo
  ```

---

## 6. Datei zurückschreiben

```ts
await vscode.workspace.fs.writeFile(
  dslUri,
  new TextEncoder().encode(dslText)
);
```

Optional:

* DSL-Datei öffnen
* Cursor auf aktualisierte Stelle setzen
* Statusmeldung anzeigen

---

## 7. Generierungslogik anpassen (wichtig!)

Beim nächsten Lauf:

```text
if DSL enthält Implementierung:
    übernehme Code direkt
else:
    LLM aufrufen
```

Damit erreichst du:

✅ deterministische Regeneration
✅ kein erneuter LLM-Kostenpunkt
✅ echtes Round-Trip-Engineering

---

## Architekturelle Einordnung (wichtig für Paper / Lehre)

Was du baust, ist **kein klassischer Codegen**, sondern:

> **Prompt-annotated model-centric code generation with human-in-the-loop refinement**

Oder einfacher:

* **Model-first**
* **LLM-assisted**
* **Round-trip capable**

Das ist **inhaltlich sehr stark** – gerade für Lehre & Forschung.

---

## Meine klare Empfehlung

**Unbedingt einführen:**

1. **Stabile DSL-ID im JavaDoc**
2. **Expliziter Implementierungsblock in der DSL**
3. **VS-Code Command „Übernehme Implementierung“**
4. **LLM nur als Fallback**

Damit ist dein Tool:

* reproduzierbar
* didaktisch erklärbar
* technisch sauber
* publishable 😉

---

Wenn du willst, können wir als nächsten Schritt:

* ein **konkretes DSL-Syntax-Design** festziehen
* oder den **Propagation-Command vollständig ausformulieren**
* oder das Ganze **als Architekturdiagramm für einen Vortrag / Paper** aufbereiten

Sag mir einfach, wo du ansetzen willst.
