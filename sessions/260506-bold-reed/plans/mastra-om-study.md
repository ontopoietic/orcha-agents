# Mastra's Observational Memory — Implementierungs-Erkenntnisse

## 1. Executive Summary

Mastra's Observational Memory (OM) ist ein dreistufiges Agenten-System, das klassische Token-Kompression durch zwei Background-Agenten ersetzt. Der **Observer** wird bei ~30k ungezählten Message-Tokens ausgelöst und komprimiert sie zu strukturierten, datierten Observations (mit Emoji-Priorities wie 🔴/🟡/🟢). Der **Reflector** konsolidiert Observations bei ~40k Tokens, identifiziert redundante Info und garbage-collected veraltete Einträge. Ein Kern-Merkmal: **Async Buffering** — beide Agenten laufen im Hintergrund (bei 20%/50% der Threshold), was die Hauptschleife nicht blockiert. Observations und Reflections werden in `ObservationalMemoryRecord` in Storage persistiert, Originalmessages bleiben referenzierbar. Das System bietet auch **Shared Token Budget** (Observation- und Message-Space werden dynamisch ausgetauscht), **Degeneration Detection** (LLM-Reflexionen die zu repetitiv sind), und optionale **Retrieval Mode** zur Recall des Rohmaterials.

---

## 2. Repo-Topographie

### Verzeichnisstruktur

```
packages/memory/src/processors/observational-memory/
├── observational-memory.ts          # Hauptklasse (Trigger-Logik, Kontext-Assembly)
├── processor.ts                      # Processor-Adapter (Input/Output-Lifecycle)
├── types.ts                          # Alle TypeScript-Interfaces (Konfiguration, Marker, etc.)
├── constants.ts                      # Defaults (30k/40k Thresholds, System-Prompts)
├── observer-agent.ts                 # Observer's System-Prompt, Parsing, Extraction-Rules
├── reflector-agent.ts                # Reflector's System-Prompt, Compression-Levels
├── observer-runner.ts                # Observer-Agent ausführen
├── reflector-runner.ts               # Reflector-Agent ausführen
├── token-counter.ts                  # Tokenizer (tokenx + Provider-APIs für Attachments)
├── thresholds.ts                     # Schwellenwert-Berechnung (Dynamic, Multiplier)
├── buffering-coordinator.ts          # Async Buffering State Machine (statisch über Prozess)
├── observation-turn/
│   ├── turn.ts                       # ObservationTurn — Orchestriert Beobachtungs-Zyklus
│   ├── step.ts                       # ObservationStep — Einzelner Beobachtungs-Schritt
│   └── types.ts                      # Turn/Step Context & Hooks
├── observation-groups.ts             # XML <observation-group> wrapping + reconciliation
├── observation-utils.ts              # Observations-Filterung & -Versioning
├── message-utils.ts                  # Message-Filtering, Buffering-Chunks
├── date-utils.ts                     # Relative Datumsangaben (z.B. "3 Tage ago")
├── markers.ts                        # Start/End/Failed Marker (DataOmObservationPart)
├── temporal-markers.ts               # Gap-Reminder bei Inaktivität
├── model-by-input-tokens.ts          # Dynamische Modell-Auswahl basierend auf Tokens
├── model-context.ts                  # Provider-Änderungen tracken
├── anchor-ids.ts                     # Ephemerale IDs für Message-Referenzen
├── observation-strategies/           # Sync vs. Async Buffering Strategien
├── debug.ts                          # Debug-Logging
├── string-utils.ts                   # Sanitisierung & Parsing
└── __tests__/                        # Test-Suite (siehe Punkt 8)
```

### Wichtigste Dateien für Adaption zu Orcha Agents

1. **types.ts:Zeile 58–178** — `ObservationConfig`, `ReflectionConfig` (Schnittstellen)
2. **constants.ts:Zeile 1–55** — Defaults (Model, Thresholds, Provider-Options)
3. **observational-memory.ts:Zeile 265+** — `class ObservationalMemory` (Kern-API)
4. **observer-agent.ts:Zeile 19+** — `OBSERVER_EXTRACTION_INSTRUCTIONS` (Prompt)
5. **reflector-agent.ts:Zeile 33+** — `buildReflectorSystemPrompt()` (Reflector-Prompt)
6. **token-counter.ts:Zeile 1098+** — `class TokenCounter` (Tokenizer)

---

## 3. Observer — Architektur

### 3.1 Trigger-Heuristik

**Datei: `token-counter.ts:Zeile 1–1599`, `observational-memory.ts`, `thresholds.ts`**

**Token-Messung:**
- **Basis:** `TokenCounter` nutzt `tokenx` (lokale Token-Schätzung) via `estimateTokenCount()` (Zeile 1128)
- **Attachment-Handling:** Für Bilder/Dateien werden Provider-spezifische Endpunkte aufgerufen:
  - OpenAI: `v1/responses/input_tokens` (Zeile 1008)
  - Anthropic: `v1/messages/count_tokens` (Zeile 1044)
  - Google: `v1beta/models/{modelId}:countTokens` (Zeile 1073)
- **Caching:** Token-Estimates werden in `message.metadata.mastra.tokenEstimate` gecacht (Zeile 224–233)
- **Overhead:** Pro-Nachricht 3.8 Tokens (Rollen-Tokens, Framing), Plus 24 Tokens Konversations-Overhead (Zeile 1106–1108)

**Schwellenwerte (konfigurierbar):**
- **`messageTokens`:** Standard 30.000 Tokens (Zeile 76, constants.ts)
- **Hartkodiert oder flexibel?** Beides:
  - **Einfach:** `messageTokens: 30_000` (Zahl) → gilt immer (Zeile 44, thresholds.ts)
  - **Dynamisch:** `messageTokens: { min: 8_000, max: 15_000 }` (ThresholdRange) → expandiert/schrumpft basierend auf Observation-Space (Zeile 28–48, thresholds.ts)

**Adaptive Thresholds (shareTokenBudget):**
- Wenn `shareTokenBudget: true`, wird der Total-Budget (30k Messages + 40k Observations) zwischen beiden geteilt
- Formeln:
  ```
  totalBudget = messageTokens.max + observationTokens.max
  effectiveThreshold = totalBudget - currentObservationTokens
  (mindestens messageTokens.min, höchstens totalBudget)
  ```
  (Zeile 28–48, thresholds.ts)

**Was triggert Observation?**
- **Synchron (blockierend):** Wenn unobserved-Messages ≥ `messageTokens` Threshold überschreiten (Zeile 1025 in observational-memory.ts)
- **Async Buffering:** Bei `bufferTokens` Interval (Standard 20% von `messageTokens` = 6k Tokens) läuft Observer im Hintergrund (Zeile 21, constants.ts; Zeile 61–62, buffering-coordinator.ts)
- **Aktivierung:** Wenn buffered Observations Ready sind UND Threshold erreicht → instant swap (blockfrei)
- **Force-Activate:** Nach `activateAfterIdle` TTL (z.B. "5m") oder bei Provider-Wechsel

**Trigger-Punkt im Loop:**
- **Pre-Send:** `processInputStep()` prüft Token-Count und injiziert Observations in Kontext (processor.ts:Zeile 88)
- **Post-Send:** `processOutputResult()` speichert neue Messages und prüft ob Threshold überschritten (processor.ts)

---

### 3.2 Observer — Output-Format

**Datei: `observer-agent.ts:Zeile 150+`, `types.ts:Zeile 256–262`**

**Observation-Format (Beispiel):**

```
Date: December 4, 2025

🔴 (14:30) User is building a TypeScript auth system
🔴 (14:35) User will integrate OAuth with GitHub (meaning Dec 7, 2025)
🟡 (14:40) Discussed using JWT tokens for session management
🟢 (14:45) ✅ Created login form component

<thread id="thread-2">
🔴 (15:00) In parallel, working on database schema
🟡 (15:05) Decided to use PostgreSQL with TypeORM
</thread>
```

**TypeScript-Type für Observer-Ausgabe:**

```typescript
export interface ObserverResult {
  /** The extracted observations (structured text as above) */
  observations: string;

  /** Suggested continuation for the Actor (optional) */
  suggestedContinuation?: string;
}
```

**Struktur-Details:**
- **Emojis:** 🔴 (critical/assertion), 🟡 (in-progress/question), 🟢 (completed/resolved)
- **Zeitstempel:** `(HH:MM)` = Nachricht-Uhrzeit; `(meaning DATE)` = referenziertes Ereignis-Datum
- **Thread-Attribution:** `<thread id="...">` für Resource-Scope (mehrere Threads)
- **Completion-Marker:** `✅` zeigt erledigte Tasks (für Degeneration Detection)

**Unterscheidung Tool-Calls vs. User/Assistant:**
- **Tool-Invocation Calls:** `User called search_files with query "auth.ts"`
- **Tool Results:** Mit `formatToolResultForObserver()` gekürzt (max 1000 Tokens, Zeile 8–11, observer-agent.ts)
- **User Statements:** `User stated they will...` (Assertion) vs. `User asked about...` (Question)

**Beispiel-Observation aus Test (long-session.test.ts):**
```
🔴 (10:30) User began implementing a new feature
🟡 (10:45) Currently debugging token counting logic
🟢 (11:15) ✅ Fixed edge case in message parser
```

---

### 3.3 Observer — System-Prompt

**Datei: `observer-agent.ts:Zeile 19–250`**

**Haupt-Extraktions-Instruktionen:**

```typescript
export const OBSERVER_EXTRACTION_INSTRUCTIONS = `CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something about themselves, mark it as an assertion:
- "I have two kids" → 🔴 (14:30) User stated has two kids

When the user ASKS about something, mark it as a question/request:
- "Can you help me with X?" → 🔴 (15:00) User asked help with X

STATE CHANGES AND UPDATES:
When a user indicates they are changing something, frame it as a state change:
- "I'm switching from A to B" → "User is switching from A to B"

TEMPORAL ANCHORING:
Each observation has TWO timestamps:
1. BEGINNING: When statement was made (message timestamp)
2. END: When referenced event happens (only if different) — "(meaning DATE)"

PRESERVE UNUSUAL PHRASING:
When user uses non-standard terminology, quote their exact words.

USE PRECISE ACTION VERBS:
Replace "getting" with "subscribed", "purchased", etc.

SPLIT MULTIPLE EVENTS:
BAD: User will visit parents this weekend and go to dentist tomorrow.
GOOD (split):
  User will visit their parents this weekend. (meaning June 17-18, 2025)
  User will go to the dentist tomorrow. (meaning June 16, 2025)
`
```

**Wie wird der Observer aufgerufen?**
1. **Messages sammeln:** Alle unobserved Messages seit `lastObservedAt` (observational-memory.ts:Zeile 1025)
2. **Formatting:** Via `buildObserverPrompt()` oder `buildMultiThreadObserverPrompt()` (observer-agent.ts)
3. **System-Prompt:**
   ```typescript
   buildObserverSystemPrompt(instruction?: string): string
   // => Kombiniert OBSERVER_EXTRACTION_INSTRUCTIONS + OUTPUT_FORMAT + GUIDELINES
   // + Optional custom instruction
   ```
4. **Model für Observer:**
   - **Default:** `google/gemini-2.5-flash` (constants.ts:Zeile 6)
   - **Settings:** `temperature: 0.3`, `maxOutputTokens: 100_000` (Zeile 8–10)
   - **Provider-Options:** Google Thinking Budget 215 (Zeile 12–15)
   - **Dynamisch:** Kann via `ModelByInputTokens` basierend auf Input-Tokens gewählt werden

---

### 3.4 Ausgabe-Parsing

**Datei: `observer-agent.ts:Zeile 250–350`**

```typescript
export function parseObserverOutput(output: string, sourceObservations?: string): ObserverResult {
  // 1. Extract <observations> XML block
  // 2. Sanitize lines (remove invalid formatting)
  // 3. Optional: wrapInObservationGroup() für Retrieval-Mode
  // 4. Return { observations, suggestedContinuation }
}
```

---

## 4. Reflector — Architektur

**Datei: `reflector-agent.ts:Zeile 1–300`**

### 4.1 Trigger-Bedingung

- **Threshold:** `observationTokens: 40.000` (Standard, Zeile 26, constants.ts)
- **Dito wie Observer:** Dynamisch via ThresholdRange, blockfrei via Async Buffering
- **Buffering-Ratio:** `bufferActivation: 0.5` = Startet bei 50% der Schwelle (Zeile 39, constants.ts)

### 4.2 Konsolidierungs-Logik

**„Garbage Collect" bedeutet:**
- **Nicht:** Automatisches Löschen. Sondern: **LLM-gesteuerte Neuorganisation**
- **Heuristik:** Reflector evaluiert jede Observation:
  - Wird diese Information noch benötigt?
  - Ist diese Observation durch neuere Infos verdrängt worden?
  - Können mehrere Observations zu einer übergeordneten Aussage zusammengefasst werden?

**Compression-Levels (0–4):**

```typescript
export const COMPRESSION_GUIDANCE: Record<CompressionLevel, string> = {
  0: '', // Keine Anleitung — erste Reflexion
  1: 'Gentle compression — ein bisschen zusammenfassen',
  2: 'Aggressive compression — 8/10 detail level',
  3: 'Critical compression — 6/10 detail level',
  4: 'Extreme compression — 2/10 detail level (nur Outcomes)'
}
```

(Zeile 154–226, reflector-agent.ts)

Wenn Reflections zu groß sind → Retry mit höherem Level.

### 4.3 Merge-Strategie

**„Related Items Merge":**
1. **Gleiche Thema:** Wenn 5 Observations über die gleiche Datei sind → 1 Zeile mit Outcome
2. **Duplikate:** Wenn ein älterer und ein neuerer State existieren → neuester State siegt
3. **Completion Markers (`✅`):** BLEIBEN und werden BEIBEHALTEN (sind Memory-Signale)

**Beispiel:**
```
Input:
🟡 (10:00) Viewed auth.ts
🟡 (10:05) Edited login function
🟡 (10:10) Searched for token validation
🟢 (10:15) ✅ Fixed token validation logic

Output (nach Reflektion):
🟢 (10:15) ✅ Investigated auth.ts and fixed token validation logic
```

### 4.4 Degeneration Detection

**Datei: `observer-agent.ts:Zeile 385–420`**

```typescript
export function detectDegenerateRepetition(observations: string): boolean {
  // Prüft ob Output zu sehr sich selbst wiederholt
  // Beispiel: Wenn 80%+ der Zeilen identisch sind → degenerate
  // Rückgabe: true = verwerfen und Retry
}
```

Wenn degenerate → Reflection mit höherem `COMPRESSION_LEVEL` erneut versuchen.

### 4.5 System-Prompt des Reflectors

**Datei: `reflector-agent.ts:Zeile 33–129`**

```typescript
export function buildReflectorSystemPrompt(instruction?: string): string {
  return `You are the memory consciousness of an AI assistant...
  
Your reason for existing is to reflect on all the observations, 
re-organize and streamline them, and draw connections and conclusions.

IMPORTANT: your reflections are THE ENTIRETY of the assistants memory. 
Any information you do not add will be immediately forgotten.

When consolidating observations:
- Preserve and include dates/times when present
- Retain the most relevant timestamps
- Combine related items where it makes sense
- Preserve ✅ completion markers — they are memory signals
- Condense older observations more aggressively, retain more detail for recent ones

CRITICAL: USER ASSERTIONS vs QUESTIONS
- "User stated: X" = authoritative assertion
- "User asked: X" = question/request
When consolidating, USER ASSERTIONS TAKE PRECEDENCE.
...`
}
```

**Thread-Attribution (Resource-Scope):**
```
When observations contain <thread id="..."> sections:
- MAINTAIN thread attribution where thread-specific context matters
- CONSOLIDATE cross-thread facts that are stable/universal
- When consolidating, you may merge observations from multiple threads 
  if they represent the same universal fact
```

**Output-Format (XML):**
```xml
<observations>
[consolidated observations with date groups and emojis]
</observations>

<current-task>
[primary/secondary tasks extracted from observations]
</current-task>

<suggested-response>
[hint for agent's next action]
</suggested-response>
```

---

## 5. Persistierung und Versioning

**Datei: `packages/core/src/storage/types.ts:Zeile 1034–1150`**

### 5.1 DB-Schema (ObservationalMemoryRecord)

```typescript
export interface ObservationalMemoryRecord {
  // Identity
  id: string;                              // Unique record ID
  scope: 'thread' | 'resource';            // Memory scope
  threadId: string | null;                 // null for resource-scope
  resourceId: string;                      // Always present
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  lastObservedAt?: Date;                   // When we last observed ANY thread
  
  // Generation tracking
  originType: 'initial' | 'reflection';    // How record was created
  generationCount: number;                 // Incremented on each reflection
  
  // Observation content
  activeObservations: string;              // Current observations (live)
  bufferedObservationChunks?: BufferedObservationChunk[]; // Queued observations
  bufferedReflection?: string;             // Queued reflection
  bufferedReflectionTokens?: number;       // Output token count (compressed)
  bufferedReflectionInputTokens?: number;  // Input token count (before compression)
  reflectedObservationLineCount?: number;  // How many lines were reflected on
  
  // Message tracking
  observedMessageIds?: string[];           // Messages observed in generation
  observedTimezone?: string;               // Timezone for date formatting
  
  // Token tracking
  totalTokensObserved: number;             // Cumulative tokens
  observationTokenCount: number;           // Size of activeObservations
  pendingMessageTokens: number;            // Accumulated unobserved tokens
  
  // State flags
  isObserving: boolean;                    // Observation in progress?
  isReflecting: boolean;                   // Reflection in progress?
  isBufferingObservation: boolean;         // Async buffering in progress?
  isBufferingReflection: boolean;          // Async reflection buffering?
}

export interface BufferedObservationChunk {
  id: string;
  cycleId: string;                         // Cycle ID (shared with markers)
  observations: string;                    // Content
  tokenCount: number;
  messageIds: string[];                    // Messages observed in this chunk
  messageTokens: number;                   // Tokens from those messages
  lastObservedAt: Date;
  createdAt: Date;
}
```

### 5.2 Versioning & Audit-Trail

**Nicht explizit implementiert, aber:**
- **`generationCount`:** Inkrementiert jedes Mal, wenn Reflection neue Version erstellt (Zeile 1060)
- **`originType`:** Zeigt ob Record original oder via Reflection erzeugt (Zeile 1058)
- **`updatedAt`:** Timestamp jeder Änderung
- **Keine Vergangenheits-Snapshots gespeichert** — alte Observations werden überschrieben
- **Observation Groups (optional Retrieval Mode):** Via `<observation-group id="..." range="startId:endId">` können Raw-Messages hinter einer Observation abgefragt werden (observation-groups.ts)

### 5.3 Gedroppte Originale — Referenzierung

**Datei: `observation-groups.ts`, `observational-memory.ts:Zeile 2468–2476`**

- **Wenn Retrieval-Mode aktiviert:** Observations werden in `<observation-group range="id1:id2">` Tags gewrappt
- **Range:** Zeigt Start und End Message-IDs der Raw-Messages
- **Recall-Tool:** Actor kann `recall(cursor="id1", page=1)` aufrufen um Raw-Messages nachzuschlagen
- **Wenn Retrieval-Mode deaktiviert:** Keine Referenzierung — Originale sind für Actor unzugänglich

Beispiel:
```
<observation-group id="grp-abc123" range="msg-001:msg-015" kind="consolidated">
Date: December 4, 2025
🔴 (14:30) User is building auth system
...
</observation-group>
```

---

## 6. Context-Window-Assembly für LLM-Calls

**Datei: `observational-memory.ts:Zeile 2432–2476`, `constants.ts:Zeile 47–75`**

### 6.1 Struktur

```typescript
async buildContextSystemMessage(opts: {
  threadId: string;
  resourceId?: string;
  record?: ObservationalMemoryRecord;
  unobservedContextBlocks?: string;        // Cross-thread messages (resource-scope)
  currentDate?: Date;
}): Promise<string | undefined>
```

**Rückgabe-Format (als Text, nicht Tokens):**

```
[BLOCK 1] Observation-Preamble:
"The following observations block contains your memory of past 
conversations with this user."

[BLOCK 2] Observations (komprimiert):
<observations>
Date: December 4, 2025
🔴 (14:30) User stated they are building an auth system
...
</observations>

[BLOCK 3] Observation-Instruktionen:
"IMPORTANT: When responding, reference specific details from these observations...
KNOWLEDGE UPDATES: When asked about current state...
PLANNED ACTIONS: If the user stated they planned to do something..."

[BLOCK 4] Thread Attribution (nur resource-scope):
"<thread id='thread-2'>
  [unobserved messages from other threads]
</thread>"

[BLOCK 5] Continuation Hint (optional):
"Please continue naturally with the conversation so far and respond 
to the latest message. Use the earlier context only as background..."

[BLOCK 6] Retrieval Instructions (wenn enabled):
"## Recall — looking up source messages
Your memory is comprised of observations which are sometimes wrapped in 
<observation-group range='startId:endId'>. These ranges point back to 
the raw messages. Use the **recall** tool to retrieve them..."
```

**Konstanten:**
```typescript
OBSERVATION_CONTEXT_PROMPT = 
  "The following observations block contains your memory of past conversations..."

OBSERVATION_CONTEXT_INSTRUCTIONS = 
  "IMPORTANT: When responding, reference specific details..."

OBSERVATION_CONTINUATION_HINT = 
  "Please continue naturally with the conversation so far..."

OBSERVATION_RETRIEVAL_INSTRUCTIONS = 
  "## Recall — looking up source messages..."
```

### 6.2 Prompt-Caching

**Nicht explizit implementiert in OM, aber:**
- **Observation Block:** Könnte gecacht werden (stabil zwischen LLM-Calls)
- **Recent Raw Messages:** Nicht gecacht (ändern sich mit jedem Turn)
- **Retrieval Instructions:** Könnte gecacht werden (static)

**Best Practice für Orcha:**
```
System Message 1 (CACHEABLE):
  - Observation Preamble
  - Observations Block
  - Instructions
  
System Message 2 (NICHT CACHEABLE):
  - Continuation Hint
  - Recent Raw Messages
```

---

## 7. Working Memory Coordination

**Datei: `packages/memory/src/tools/working-memory.ts`, `observational-memory.ts`**

**Mastra hat zwei parallele Memory-Systeme:**

1. **Observational Memory:** Komprimierte langfristige History (Observations + Reflections)
2. **Working Memory:** Kurzfristige State während des Agent-Loops (z.B. aktuell offene Tasks)

**Coordination:**
- **Working Memory ist ephemär:** Nur verfügbar während aktueller Step/Turn
- **OM ist persistent:** Überlebt über Sessions
- **Zusammenspiel:** 
  - OM stellt Background-Kontext („User hat previously XYZ")
  - Working Memory hält aktuellen State („Currently working on ABC")
  - Bei Observation: Working Memory State wird zu einer Observation konvertiert

**Keine konfligirende Logik** — sie sind orthogonal:
- OM: Vergangenheits-Kompression
- Working Memory: Gegenwarts-State

---

## 8. Test-Erkenntnisse

**Datei: `__tests__/*.test.ts`**

### 8.1 Wichtige Test-Cases

**1. Long-Session Test (long-session.test.ts)**
- Simuliert 30+ Turns durchschnittlicher Coding-Session
- Exercisiert Full Lifecycle: Buffering → Activation → Observation → Reflection
- Validiert Token-Counts & Compression

**2. Threshold Tests (thresholds.test.ts)**
```typescript
describe('calculateDynamicThreshold', () => {
  it('expands into unused observation space for range thresholds', () => {
    // 30k:40k → total budget 70k
    // 0 observations → can use full 70k
    expect(calculateDynamicThreshold({ min: 30000, max: 70000 }, 0))
      .toBe(70000);
  });
  
  it('shrinks as observations grow', () => {
    // 10k observations → 70k - 10k = 60k
    expect(calculateDynamicThreshold({ min: 30000, max: 70000 }, 10000))
      .toBe(60000);
  });
  
  it('never goes below the base threshold (min)', () => {
    // 50k observations → 70k - 50k = 20k, aber min ist 30k
    expect(calculateDynamicThreshold({ min: 30000, max: 70000 }, 50000))
      .toBe(30000);
  });
});
```

**3. Token Counter (token-counter.test.ts)**
- Tests für Text, Images (Google/OpenAI/Anthropic), PDFs
- Cache-Validierung
- Provider-API Fallbacks

**4. Observational Memory Core (observational-memory.test.ts)**
- Observer Output Parsing
- Degeneration Detection
- Activation Boundaries
- Reflection Compression Levels

**5. Marker Tests (markers.test.ts)**
- Start/End/Failed Marker Generation
- Cycle ID Tracking
- Token Accounting

**6. Message Ordering (message-ordering.test.ts)**
- Filtered Message Sequencing
- Cross-Thread Ordering (resource-scope)

### 8.2 Edge-Cases

- **Buffering bei sehr langen Messages:** Chunk-Boundaries werden fuzzy (siehe `calculateProjectedMessageRemoval()`, thresholds.ts:Zeile 115–186)
- **Degenerate Reflection:** Wenn Reflector repetitiv wird → Compression Level erhöht (reflector-agent.ts:Zeile 282)
- **Provider-Wechsel:** Buffered Observations forceActivated (model-context.ts)
- **TTL-Expiry:** Nach `activateAfterIdle` Inaktivität → Force-Activation (temporal-markers.ts)
- **Observation fehlt:** Graceful degradation (no observations injected)

---

## 9. Adaption für Orcha Agents

### 9.1 Kernkomponenten übernehmen

1. **TokenCounter** (`token-counter.ts`)
   - Direkter Port (minimal Dependencies)
   - Provider-APIs brauchen nur Credentials-Handling

2. **Observer System**
   - System-Prompt (`OBSERVER_EXTRACTION_INSTRUCTIONS`)
   - Output Format (Emoji-Priorities, Timestamps)
   - Parsing-Logik (`parseObserverOutput()`)

3. **Reflector System**
   - Prompt-Builder (`buildReflectorSystemPrompt()`)
   - Compression Guidance Levels
   - Degeneration Detection

4. **Threshold-Berechnung**
   - Dynamic Thresholds mit ThresholdRange
   - SharedTokenBudget Logic
   - Block-After Logik

5. **Async Buffering**
   - BufferingCoordinator State Machine
   - Background Scheduling

### 9.2 Was anders sein könnte in Orcha

1. **Storage:** Orcha hat eigenes Storage-Interface → Mapping zu `ObservationalMemoryRecord` nötig
2. **Model Resolution:** Orcha nutzt Gateway-Modelle → `ModelByInputTokens` anpassen
3. **Processor Integration:** Orcha hat andere Processor-Architektur → Adapt `processInputStep/Output`
4. **Prompt Caching:** Nutzen für System Messages (nicht in Mastra explizit)
5. **Observability:** Orcha könnte Tracing/Metrics besser integrieren

### 9.3 Risiken bei Adaption

1. **Token-Counter Drift:** `tokenx` ist lokale Schätzung — kann von tatsächlichen Tokens abweichen. Provider-APIs sollten als Source of Truth genutzt werden wenn möglich.
2. **Reflection Reliability:** LLM kann QA-Fehler machen (z.B. Infos verlieren). Regelmäßige Validierung nötig.
3. **Buffering Race Conditions:** Async Buffering mit statischen Maps kann in Multi-Agent-Szenarien kollidieren → Locking/Mutex nötig
4. **Storage Versioning:** Wenn Observation-Format ändert → alte Records breaken. Migration-Pfad planen.

---

## 10. Offene Fragen / Risks

### Fragen zum System

1. **„Garbage Collection" genauer:** Wie entscheidet der Reflector konkret, welche Observations zu löschen/mergen sind? Keine Heuristik im Code — komplett LLM-driven. Riskant bei schlechten Prompts.

2. **Message-Retention nach Observation:** Werden die Original-Messages nach Observation gelöscht oder nur aus Context gefiltert? → Nur gefiltert. Sie bleiben in Storage für Retrieval-Mode.

3. **Cross-Thread Conversations (resource-scope):** Wie wird verhindert, dass Observations aus thread-1 thread-2s Kontext kontaminieren? → `<thread id="...">` XML Tags + Filtering in `getOtherThreadsContext()`. Implizit.

4. **Reflection Retry-Loop:** Kann ein Reflector in Infinite Loop stecken (degenerate → retry → degenerate)? → Ja möglich, aber `MAX_COMPRESSION_LEVEL = 4` Stoppt irgendwann.

5. **Timing bei Async Buffering:** Wenn Buffering läuft UND `blockAfter` Threshold wird überschritten, was gewinnt? → `blockAfter` blockt synchron (reflector-runner.ts).

### Unerwartete Implementierungs-Details

1. **Ephemerale Anchor IDs:** Messages bekommen temporäre IDs für Observations, diese werden später gestrippt (anchor-ids.ts). Warum? → Verhindert dass alte Message-IDs in Observations hartcodiert sind.

2. **BufferingCoordinator als statische Map:** Warum nicht im OM-Instanz? → Weil mehrere OM-Instanzen pro Loop-Step erstellt werden. Statische Maps ermöglichen Sharing über Instanzen hinweg.

3. **Observation Groups nur optional:** Warum nicht immer wrappen? → Performance + Klarheit. Nur wenn `retrieval: true` nötig.

4. **Previous Observations Context:** Es gibt `previousObserverTokens` Config um alte Observations zu truncate. Why? → Um Observer nicht bei Reflection mit zu viel Kontext zu overloaden.

5. **Thread Attribution im Reflector:** Der Reflector kriegt `<thread id="...">` aber merged oft über Threads hinweg. Später wird `reconcileObservationGroupsFromReflection()` aufgerufen um die Groups wieder zu reparieren (observation-groups.ts:Zeile 291–293). Komplex!

---

## Résumé

Mastra's OM ist ein ausgefeiltes Speicher-System, das klassische Context-Compaction durch spezialisierte Agenten ersetzt. Die kritische Insight für Orcha: **Async Buffering = Blockfrei**, **Dynamic Thresholds = Flexible Context**, **Degeneration Detection = QA-Sicherung**. Die Token-Metrik (tokenx + Provider-APIs) ist solid; das Observation-Format (Emoji-Priority + Temporal Anchors) ist human-readable; der Reflector-Prompt ist prompt-engineering-heavy.

Für eine erfolgreiche Adaption zu Orcha: Fokus auf TokenCounter + Observer/Reflector Prompts zuerst, dann Storage/Processor Integration nachziehen.

---

**Quelldateien (Zusammenfassung):**
- Triggerlogik: `observational-memory.ts:Zeile 1025`, `processor.ts:Zeile 88`
- Token-Count: `token-counter.ts:Zeile 1506–1537`
- Observer-Prompt: `observer-agent.ts:Zeile 19–250`
- Reflector-Prompt: `reflector-agent.ts:Zeile 33–129`
- Storage: `types.ts (packages/core/storage):Zeile 1034–1150`
- Thresholds: `thresholds.ts:Zeile 28–48`
- Async Buffering: `buffering-coordinator.ts:Zeile 14–80`
