import {
  App,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  Notice,
  moment,
} from "obsidian";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

interface DecisionFrontmatter {
  decision_id: string;
  title: string;
  date_created: string;
  date_resolved: string | null;
  category: DecisionCategory;
  status: DecisionStatus;
  confidence: number; // 1-10 scale
  stakes: "low" | "medium" | "high" | "critical";
  time_pressure: "none" | "low" | "moderate" | "urgent";
  emotional_state: string | null;
  outcome_rating: number | null; // 1-10 scale, filled in later
  tags: string[];
}

type DecisionCategory =
  | "product"
  | "technical"
  | "business"
  | "financial"
  | "personal"
  | "fitness"
  | "creative"
  | "other";

type DecisionStatus =
  | "open"        // actively deciding
  | "committed"   // chose an option, waiting on outcome
  | "resolved"    // outcome known, rated
  | "revisited";  // went back and changed course

interface DecisionLogEntry {
  decision_id: string;
  title: string;
  file_path: string;
  frontmatter: DecisionFrontmatter;
  activity: ActivityEvent[];
  created_at: string;
  updated_at: string;
  revisit_due: string | null;
}

interface ActivityEvent {
  type: "created" | "edited" | "viewed" | "status_changed" | "outcome_logged" | "voice_input" | "revisit_prompted";
  timestamp: string;
  details?: string;
}

interface ExtractedDecision {
  title: string | null;
  category: string | null;
  status: string | null;
  confidence: number | null;
  stakes: string | null;
  time_pressure: string | null;
  emotional_state: string | null;
  options_considered: string[] | null;
  chosen_option: string | null;
  reasoning: string | null;
  expected_outcome: string | null;
  tags: string[] | null;
  seneca_observation: string | null;
}

const VALID_CATEGORIES = new Set<string>([
  "product", "technical", "business", "financial", "personal", "fitness", "creative", "other",
]);
const VALID_STATUSES = new Set<string>(["open", "committed", "resolved", "revisited"]);
const VALID_STAKES = new Set<string>(["low", "medium", "high", "critical"]);
const VALID_TIME_PRESSURE = new Set<string>(["none", "low", "moderate", "urgent"]);

const EXTRACTION_SYSTEM_PROMPT = `You are Seneca, a thinking partner. The user has spoken their thoughts out loud — this could be a specific decision, a half-formed idea, a contemplation, a problem they're wrestling with, or general rambling thoughts. Your job is to find the signal in what they said and extract structure from it. Return ONLY valid JSON with no markdown formatting, no backticks, no preamble.

{
  "title": "Short descriptive title for this decision (max 10 words)",
  "category": "One of: product, technical, business, financial, personal, fitness, creative, other",
  "status": "One of: open (still deciding), committed (chose but no outcome yet), resolved (outcome known)",
  "confidence": "1-10 how confident they sound in their choice",
  "stakes": "One of: low, medium, high, critical",
  "time_pressure": "One of: none, low, moderate, urgent",
  "emotional_state": "One or two words describing their emotional tone (e.g. excited, anxious, calm, conflicted, confident)",
  "options_considered": "Array of strings — the options they mentioned weighing",
  "chosen_option": "What they decided (or null if still open)",
  "reasoning": "1-2 sentence summary of why they chose what they chose",
  "expected_outcome": "What they think will happen (or null if not mentioned)",
  "tags": "Array of relevant keyword tags",
  "seneca_observation": "1-2 sentences of non-obvious insight about the user's thinking process. Don't restate what they said. Instead, notice: contradictions between their confidence and their language, options they dismissed too quickly, assumptions they're making, emotional undercurrents they may not be aware of, a sharp question they haven't asked themselves yet, or a connection to a bigger pattern in their thinking. Be direct and specific. This should feel like a wise advisor pointing out something they missed."
}

If the user isn't making a specific decision but rather exploring an idea or thinking out loud, still extract what you can — give it a title, infer the category, capture their emotional state, and provide a meaningful observation. The observation is the most important field. Even for vague or rambling input, always find something worth reflecting back.

If a field can't be determined from the transcript, use null. Always provide your best inference for title, category, emotional_state, and seneca_observation.

You may also receive the user's recent decision history. If provided, USE IT to make the seneca_observation richer — reference patterns, recurring themes, related past decisions, or contradictions with previous choices. This is what makes you a thinking partner rather than a one-shot parser. Don't force connections that aren't there, but when a genuine link exists, name it.`;

const ANALYSIS_SYSTEM_PROMPT = `You are Seneca, a decision intelligence analyst. The user will provide their decision log as JSON. Produce a detailed markdown analysis report. Do NOT wrap the output in code fences — return raw markdown only.

Structure your report exactly like this:

# Seneca — Decision Analysis

## Decision Quality Score: {X}/100
One-sentence summary of their overall decision-making quality.

## Decision Velocity
- Decisions per month (calculate from date range)
- Trend: accelerating, steady, or slowing

## Calibration Analysis
For resolved decisions with both confidence and outcome_rating: how well does their confidence predict actual outcomes? Are they overconfident, underconfident, or well-calibrated? Show the data.

## Category Breakdown
For each category with decisions: count, average outcome rating (if any resolved), and a one-line observation.

## Emotional State Patterns
Which emotional states at decision time correlate with better/worse outcomes? Any surprising patterns?

## Stakes & Time Pressure Impact
How do high-stakes vs low-stakes decisions turn out? Do urgent decisions perform worse? Show the data.

## Top 3 Strengths
Specific things they do well, backed by evidence from their log.

## Top 3 Blind Spots
Patterns that suggest systematic errors or biases. Be direct and specific.

## Recommendations
3-5 actionable, specific recommendations based on the data. Not generic advice — tie each one to a pattern you observed.

## Pending Decisions
List any open/committed decisions that have been unresolved for a long time and may need attention.

Be data-driven. Reference specific decisions by title when making points. Be direct and honest — the user wants to improve, not be flattered.`;

interface SenecaSettings {
  decisionsFolder: string;
  logFileName: string;
  defaultCategory: DecisionCategory;
  templateStyle: "full" | "quick";
  openaiApiKey: string;
  revisitDays: number;
  lastRevisitCheck: string;
}

const DEFAULT_SETTINGS: SenecaSettings = {
  decisionsFolder: "Seneca/Decisions",
  logFileName: "Seneca/seneca-log.json",
  defaultCategory: "other",
  templateStyle: "full",
  openaiApiKey: "",
  revisitDays: 30,
  lastRevisitCheck: "",
};

// ─────────────────────────────────────────────
// DECISION TEMPLATE GENERATORS
// ─────────────────────────────────────────────

function generateDecisionId(): string {
  const now = moment();
  const random = Math.random().toString(36).substring(2, 6);
  return `DEC-${now.format("YYYYMMDD")}-${random}`;
}

function buildFullTemplate(id: string, category: DecisionCategory): string {
  const now = moment().format("YYYY-MM-DD HH:mm");

  return `---
decision_id: "${id}"
title: ""
date_created: "${now}"
date_resolved: null
category: "${category}"
status: "open"
confidence: 5
stakes: "medium"
time_pressure: "low"
emotional_state: null
outcome_rating: null
tags: []
---

# Decision: [Title]

## Context
> What's happening? Why does this decision need to be made now?



## Options Considered

### Option A: [Name]
- **Pros:**
  - 
- **Cons:**
  - 
- **Estimated likelihood of success:**

### Option B: [Name]
- **Pros:**
  - 
- **Cons:**
  - 
- **Estimated likelihood of success:**

### Option C: [Name]
_(Add or remove options as needed)_

## Research & Evidence
> Links, data, conversations, or notes that informed this decision.

- 

## Decision Made
> What did you choose and why? What was the deciding factor?

**Chosen option:**

**Reasoning:**

**What would change your mind:**

## Expected Outcome
> What do you think will happen? Be specific so you can compare later.

**Best case:**

**Likely case:**

**Worst case:**

**Timeline for knowing:**

## Actual Outcome
_(Fill this in when the decision resolves)_

**What happened:**

**Outcome rating (1-10):**

**What surprised you:**

**What you'd do differently:**

## Reflection
_(Seneca will help synthesize this over time, but capture your raw thoughts here)_

`;
}

function buildQuickTemplate(id: string, category: DecisionCategory): string {
  const now = moment().format("YYYY-MM-DD HH:mm");

  return `---
decision_id: "${id}"
title: ""
date_created: "${now}"
date_resolved: null
category: "${category}"
status: "open"
confidence: 5
stakes: "medium"
time_pressure: "low"
emotional_state: null
outcome_rating: null
tags: []
---

# Decision: [Title]

**Context:** 

**Options:**
1. 
2. 

**Chose:** 

**Why:** 

**Expected outcome:** 

---

## Outcome _(fill in later)_
**What happened:** 

**Rating (1-10):** 

**Lesson:** 

`;
}

function buildVoiceTemplate(id: string, category: DecisionCategory, transcript: string): string {
  const now = moment().format("YYYY-MM-DD HH:mm");

  return `---
decision_id: "${id}"
title: ""
date_created: "${now}"
date_resolved: null
category: "${category}"
status: "open"
confidence: 5
stakes: "medium"
time_pressure: "low"
emotional_state: null
outcome_rating: null
tags: []
---

# Decision: [Title]

**Context:** 

**Options:**
1. 
2. 

**Chose:** 

**Why:** 

**Expected outcome:** 

## Voice Transcript

${transcript}

---

## Outcome _(fill in later)_
**What happened:** 

**Rating (1-10):** 

**Lesson:** 

`;
}

function buildExtractedVoiceTemplate(
  id: string,
  extracted: ExtractedDecision,
  transcript: string,
): string {
  const now = moment().format("YYYY-MM-DD HH:mm");

  const title = extracted.title || "";
  const category = VALID_CATEGORIES.has(extracted.category || "") ? extracted.category : "other";
  const status = VALID_STATUSES.has(extracted.status || "") ? extracted.status : "open";
  const confidence = typeof extracted.confidence === "number"
    ? Math.max(1, Math.min(10, Math.round(extracted.confidence)))
    : 5;
  const stakes = VALID_STAKES.has(extracted.stakes || "") ? extracted.stakes : "medium";
  const timePressure = VALID_TIME_PRESSURE.has(extracted.time_pressure || "")
    ? extracted.time_pressure
    : "low";
  const emotionalState = extracted.emotional_state
    ? `"${extracted.emotional_state}"`
    : "null";
  const tags = Array.isArray(extracted.tags) && extracted.tags.length > 0
    ? `[${extracted.tags.map((t) => `"${t}"`).join(", ")}]`
    : "[]";

  const optionsList = Array.isArray(extracted.options_considered) && extracted.options_considered.length > 0
    ? extracted.options_considered.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "1. \n2. ";
  const chosen = extracted.chosen_option || "";
  const reasoning = extracted.reasoning || "";
  const expectedOutcome = extracted.expected_outcome || "";
  const observation = extracted.seneca_observation || "";

  const observationSection = observation
    ? `\n## Seneca observes\n\n> ${observation}\n`
    : "";

  return `---
decision_id: "${id}"
title: "${title}"
date_created: "${now}"
date_resolved: null
category: "${category}"
status: "${status}"
confidence: ${confidence}
stakes: "${stakes}"
time_pressure: "${timePressure}"
emotional_state: ${emotionalState}
outcome_rating: null
tags: ${tags}
---

# Decision: ${title || "[Title]"}

**Options considered:**
${optionsList}

**Chose:** ${chosen}

**Why:** ${reasoning}

**Expected outcome:** ${expectedOutcome}
${observationSection}
---

## Voice Transcript

> ${transcript}

---

## Outcome _(fill in later)_
**What happened:** 

**Rating (1-10):** 

**Lesson:** 

`;
}

// ─────────────────────────────────────────────
// VOICE RECORDING MODAL
// ─────────────────────────────────────────────

class VoiceRecordingModal extends Modal {
  plugin: SenecaPlugin;
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: BlobPart[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrame: number | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private recordingStartTime = 0;

  constructor(app: App, plugin: SenecaPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("seneca-voice-modal");

    try {
      await this.initRecordingUI(contentEl);
    } catch (err) {
      contentEl.empty();
      const msg = err instanceof Error ? err.message : String(err);
      contentEl.createEl("h3", { text: "Seneca — Voice Error" });
      contentEl.createEl("p", { text: msg });
      contentEl.createEl("p", {
        text: "On macOS: System Settings → Privacy & Security → Microphone → enable Obsidian.",
        cls: "mod-muted",
      });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").setCta().onClick(() => this.close())
      );
    }
  }

  private async initRecordingUI(contentEl: HTMLElement) {
    if (!this.plugin.settings.openaiApiKey) {
      contentEl.createEl("p", {
        text: "No OpenAI API key configured. Add one in Seneca settings.",
      });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").setCta().onClick(() => this.close())
      );
      return;
    }

    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      .seneca-voice-modal { text-align: center; padding: 1em; }
      .seneca-voice-status { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 1em 0; font-size: 1.2em; }
      .seneca-recording-dot { width: 12px; height: 12px; border-radius: 50%; background: #e53935; display: inline-block; }
      .seneca-recording-dot.pulsing { animation: seneca-pulse 1.2s ease-in-out infinite; }
      .seneca-recording-dot.transcribing { background: #f9a825; }
      @keyframes seneca-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      .seneca-voice-buttons { display: flex; gap: 8px; justify-content: center; margin-top: 1em; }
      .seneca-level-bar-bg { width: 80%; max-width: 300px; height: 6px; background: var(--background-modifier-border); border-radius: 3px; margin: 0.5em auto; overflow: hidden; }
      .seneca-level-bar { height: 100%; background: #e53935; border-radius: 3px; transition: width 50ms linear; width: 0%; }
      .seneca-timer { font-size: 0.9em; color: var(--text-muted); margin-top: 4px; }
    `;
    document.head.appendChild(this.styleEl);

    const statusEl = contentEl.createEl("div", { cls: "seneca-voice-status" });
    const dotEl = statusEl.createEl("span", { cls: "seneca-recording-dot pulsing" });
    const labelEl = statusEl.createEl("span", { text: "Requesting microphone..." });

    const meterBg = contentEl.createEl("div", { cls: "seneca-level-bar-bg" });
    const meterFill = meterBg.createEl("div", { cls: "seneca-level-bar" });
    const timerEl = contentEl.createEl("div", { cls: "seneca-timer", text: "0:00" });

    const buttonsEl = contentEl.createEl("div", { cls: "seneca-voice-buttons" });
    const stopBtn = buttonsEl.createEl("button", { text: "Stop & Save", cls: "mod-cta" });
    const cancelBtn = buttonsEl.createEl("button", { text: "Cancel" });
    stopBtn.disabled = true;

    cancelBtn.addEventListener("click", () => {
      this.cleanup();
      this.close();
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone API not available in this environment.");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // AnalyserNode for real-time level meter
    this.audioContext = new AudioContext();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    this.analyser.connect(silentGain);
    silentGain.connect(this.audioContext.destination);

    this.startLevelMeter(meterFill);

    // MediaRecorder for actual audio capture
    // Try formats in order: webm/opus (desktop), mp4 (iOS), ogg, then browser default
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
    this.audioChunks = [];
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.audioChunks.push(e.data);
      }
    };

    // Use 1s timeslice so ondataavailable fires during recording (iOS requires this)
    this.mediaRecorder.start(1000);
    this.recordingStartTime = Date.now();

    // Update timer display
    const timerInterval = window.setInterval(() => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        clearInterval(timerInterval);
        return;
      }
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timerEl.setText(`${mins}:${secs.toString().padStart(2, "0")}`);
    }, 500);

    labelEl.setText("Recording... (speak now)");
    stopBtn.disabled = false;

    stopBtn.addEventListener("click", async () => {
      try {
        stopBtn.disabled = true;
        cancelBtn.disabled = true;
        clearInterval(timerInterval);

        const blob = await this.stopMediaRecorder();
        this.stopLevelMeter();

        const sizeKB = (blob.size / 1024).toFixed(0);
        const durationSec = ((Date.now() - this.recordingStartTime) / 1000).toFixed(1);

        if (blob.size < 1000) {
          new Notice(
            `Seneca: Recording empty (${blob.size}B, format=${mimeType || "default"}, chunks=${this.audioChunks.length}). Check mic permissions.`,
            10000,
          );
          this.close();
          return;
        }

        new Notice(`Seneca: Captured ${sizeKB}KB (~${durationSec}s). Transcribing...`);

        dotEl.removeClass("pulsing");
        dotEl.addClass("transcribing");
        labelEl.setText("Transcribing...");
        meterBg.style.display = "none";
        timerEl.style.display = "none";
        buttonsEl.style.display = "none";

        const transcript = await this.transcribe(blob, mimeType);
        this.close();
        await this.plugin.createVoiceDecision(transcript);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Seneca: Voice flow failed — ${msg}`, 10000);
        this.close();
      }
    });
  }

  private stopMediaRecorder(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        resolve(new Blob(this.audioChunks, { type: "audio/webm;codecs=opus" }));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, { type: this.mediaRecorder?.mimeType ?? "audio/webm;codecs=opus" });
        resolve(blob);
      };

      try { this.mediaRecorder.requestData(); } catch { /* not supported on all platforms */ }
      this.mediaRecorder.stop();
    });
  }

  private startLevelMeter(meterFill: HTMLElement) {
    if (!this.analyser) return;
    const bufLen = this.analyser.fftSize;
    const dataArray = new Uint8Array(bufLen);

    const draw = () => {
      if (!this.analyser) return;
      // Time-domain waveform: values centered at 128, deviate with sound
      this.analyser.getByteTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < bufLen; i++) {
        const amplitude = Math.abs(dataArray[i] - 128);
        if (amplitude > peak) peak = amplitude;
      }
      // peak is 0-128; normalize to 0-100%
      const pct = Math.min(100, (peak / 128) * 100 * 1.5);
      meterFill.style.width = `${pct}%`;
      this.animFrame = requestAnimationFrame(draw);
    };
    draw();
  }

  private stopLevelMeter() {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
    this.analyser = null;
  }

  private cleanup() {
    this.stopLevelMeter();

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
    }
    this.audioContext = null;

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private async transcribe(audioBlob: Blob, mimeType: string): Promise<string> {
    const extMap: Record<string, string> = {
      "audio/webm;codecs=opus": "webm", "audio/webm": "webm",
      "audio/mp4": "m4a", "audio/ogg;codecs=opus": "ogg", "audio/ogg": "ogg",
    };
    const ext = extMap[mimeType] || "webm";
    const file = new File([audioBlob], `recording.${ext}`, { type: mimeType || "audio/webm" });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-1");
    formData.append("response_format", "text");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.plugin.settings.openaiApiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error (${response.status}): ${errorText}`);
    }

    return (await response.text()).trim();
  }

  onClose() {
    this.cleanup();
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
    this.contentEl.empty();
  }
}

// ─────────────────────────────────────────────
// MAIN PLUGIN
// ─────────────────────────────────────────────

export default class SenecaPlugin extends Plugin {
  settings: SenecaSettings;
  log: DecisionLogEntry[] = [];

  async onload() {
    await this.loadSettings();
    await this.loadLog();

    // ── Command: Log New Decision (Full) ──
    this.addCommand({
      id: "seneca-new-decision",
      name: "Log new decision",
      callback: () => this.createDecision("full"),
    });

    // ── Command: Quick Decision ──
    this.addCommand({
      id: "seneca-quick-decision",
      name: "Quick decision log",
      callback: () => this.createDecision("quick"),
    });

    // ── Command: Voice Decision ──
    this.addCommand({
      id: "seneca-voice-decision",
      name: "Voice decision",
      callback: () => new VoiceRecordingModal(this.app, this).open(),
    });

    // ── Command: Update Outcome ──
    this.addCommand({
      id: "seneca-log-outcome",
      name: "Log outcome for current decision",
      callback: () => this.promptOutcomeUpdate(),
    });

    // ── Command: View Decision Stats ──
    this.addCommand({
      id: "seneca-stats",
      name: "View decision stats",
      callback: () => this.showStats(),
    });

    // ── Command: Export Log for AI Analysis ──
    this.addCommand({
      id: "seneca-export",
      name: "Export log for AI analysis",
      callback: () => this.exportForAnalysis(),
    });

    // ── Command: Analyze My Decisions ──
    this.addCommand({
      id: "seneca-analyze",
      name: "Analyze my decisions",
      callback: () => this.analyzeDecisions(),
    });

    // ── Command: Import Decisions ──
    this.addCommand({
      id: "seneca-import",
      name: "Import decisions from file",
      callback: () => this.importDecisions(),
    });

    // ── Vault Watcher: Track edits to decision files ──
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isDecisionFile(file)) {
          this.logActivity(file, "edited");
        }
      })
    );

    // ── Settings Tab ──
    this.addSettingTab(new SenecaSettingTab(this.app, this));

    new Notice("Seneca loaded — ready to track decisions.");

    // ── On-Load Revisit Check (deferred so UI is ready) ──
    this.app.workspace.onLayoutReady(() => {
      this.checkPendingRevisits();
    });
  }

  // ── Decision Creation ──

  async createDecision(style: "full" | "quick") {
    const id = generateDecisionId();
    const category = this.settings.defaultCategory;

    const template =
      style === "full"
        ? buildFullTemplate(id, category)
        : buildQuickTemplate(id, category);

    // Ensure decisions folder exists
    const folder = this.settings.decisionsFolder;
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }

    const fileName = `${folder}/${id}.md`;
    const file = await this.app.vault.create(fileName, template);

    // Add to log
    const entry: DecisionLogEntry = {
      decision_id: id,
      title: "",
      file_path: fileName,
      frontmatter: {
        decision_id: id,
        title: "",
        date_created: moment().format("YYYY-MM-DD HH:mm"),
        date_resolved: null,
        category,
        status: "open",
        confidence: 5,
        stakes: "medium",
        time_pressure: "low",
        emotional_state: null,
        outcome_rating: null,
        tags: [],
      },
      activity: [
        {
          type: "created",
          timestamp: moment().toISOString(),
        },
      ],
      created_at: moment().toISOString(),
      updated_at: moment().toISOString(),
      revisit_due: moment().add(this.settings.revisitDays, "days").toISOString(),
    };

    this.log.push(entry);
    await this.saveLog();

    // Open the new note
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);

    new Notice(`Seneca: Decision ${id} created.`);
  }

  // ── Voice Decision Creation ──

  async createVoiceDecision(transcript: string) {
    const id = generateDecisionId();
    const now = moment();

    new Notice("Seneca: Analyzing decision...");

    let extracted: ExtractedDecision | null = null;
    try {
      extracted = await this.extractDecisionFields(transcript);
    } catch (err) {
      new Notice(
        `Seneca: Could not parse decision — saved raw transcript`
      );
    }

    const template = extracted
      ? buildExtractedVoiceTemplate(id, extracted, transcript)
      : buildVoiceTemplate(id, this.settings.defaultCategory, transcript);

    const title = extracted?.title || "";
    const category = (
      extracted && VALID_CATEGORIES.has(extracted.category || "")
        ? extracted.category
        : this.settings.defaultCategory
    ) as DecisionCategory;
    const status = (
      extracted && VALID_STATUSES.has(extracted.status || "")
        ? extracted.status
        : "open"
    ) as DecisionStatus;
    const confidence = extracted?.confidence
      ? Math.max(1, Math.min(10, Math.round(extracted.confidence)))
      : 5;
    const stakes = (
      extracted && VALID_STAKES.has(extracted.stakes || "")
        ? extracted.stakes
        : "medium"
    ) as DecisionFrontmatter["stakes"];
    const timePressure = (
      extracted && VALID_TIME_PRESSURE.has(extracted.time_pressure || "")
        ? extracted.time_pressure
        : "low"
    ) as DecisionFrontmatter["time_pressure"];
    const emotionalState = extracted?.emotional_state || null;
    const tags = Array.isArray(extracted?.tags) ? extracted.tags : [];

    const folder = this.settings.decisionsFolder;
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }

    const fileName = `${folder}/${id}.md`;
    const file = await this.app.vault.create(fileName, template);

    const entry: DecisionLogEntry = {
      decision_id: id,
      title,
      file_path: fileName,
      frontmatter: {
        decision_id: id,
        title,
        date_created: now.format("YYYY-MM-DD HH:mm"),
        date_resolved: null,
        category,
        status,
        confidence,
        stakes,
        time_pressure: timePressure,
        emotional_state: emotionalState,
        outcome_rating: null,
        tags,
      },
      activity: [
        {
          type: "created",
          timestamp: now.toISOString(),
        },
        {
          type: "voice_input",
          timestamp: now.toISOString(),
          details: `Transcribed ${transcript.length} characters from voice${extracted ? ", analyzed by LLM" : ""}`,
        },
      ],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      revisit_due: now.clone().add(this.settings.revisitDays, "days").toISOString(),
    };

    this.log.push(entry);
    await this.saveLog();

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);

    if (extracted?.seneca_observation) {
      new Notice(`Seneca: ${extracted.seneca_observation}`, 12000);
    } else {
      new Notice(
        title
          ? `Seneca: Decision logged — ${title}`
          : `Seneca: Voice decision ${id} created.`
      );
    }
  }

  // ── LLM Decision Extraction ──

  private buildDecisionContext(): string {
    if (this.log.length === 0) return "";

    const recent = this.log
      .slice()
      .sort((a, b) => moment(b.created_at).diff(moment(a.created_at)))
      .slice(0, 15);

    const lines = recent.map((e) => {
      const parts = [
        e.title || "untitled",
        `(${e.frontmatter.category}, ${e.frontmatter.status})`,
      ];
      if (e.frontmatter.emotional_state) parts.push(`feeling: ${e.frontmatter.emotional_state}`);
      if (e.frontmatter.confidence) parts.push(`confidence: ${e.frontmatter.confidence}/10`);
      if (e.frontmatter.tags.length > 0) parts.push(`tags: ${e.frontmatter.tags.join(", ")}`);
      parts.push(`— ${moment(e.created_at).fromNow()}`);
      return `- ${parts.join(" | ")}`;
    });

    return `\n\nRecent decision history (${this.log.length} total):\n${lines.join("\n")}`;
  }

  private async extractDecisionFields(transcript: string): Promise<ExtractedDecision> {
    const context = this.buildDecisionContext();
    const userMessage = context
      ? `${transcript}\n\n---\n${context}`
      : transcript;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.settings.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    let content: string = data.choices?.[0]?.message?.content ?? "";

    // Strip markdown code fences if the model wrapped its response
    content = content.trim();
    if (content.startsWith("```")) {
      content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    return JSON.parse(content) as ExtractedDecision;
  }

  // ── Activity Logging ──

  async logActivity(file: TFile, type: ActivityEvent["type"], details?: string) {
    const entry = this.log.find((e) => e.file_path === file.path);
    if (!entry) return;

    entry.activity.push({
      type,
      timestamp: moment().toISOString(),
      details,
    });
    entry.updated_at = moment().toISOString();

    // Sync frontmatter from file
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter) {
      const fm = cache.frontmatter as Partial<DecisionFrontmatter>;
      entry.frontmatter = { ...entry.frontmatter, ...fm };
      entry.title = fm.title || entry.title;
    }

    await this.saveLog();
  }

  // ── Outcome Prompt ──

  async promptOutcomeUpdate() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !this.isDecisionFile(activeFile)) {
      new Notice("Seneca: Open a decision file first.");
      return;
    }

    const entry = this.log.find((e) => e.file_path === activeFile.path);
    if (!entry) {
      new Notice("Seneca: This decision isn't in the log yet.");
      return;
    }

    // Update status to resolved, clear revisit, and log the event
    entry.frontmatter.status = "resolved";
    entry.frontmatter.date_resolved = moment().format("YYYY-MM-DD HH:mm");
    entry.revisit_due = null;
    this.logActivity(activeFile, "outcome_logged");

    new Notice(
      "Seneca: Decision marked as resolved. Fill in the Outcome section and update outcome_rating in frontmatter."
    );
  }

  // ── Stats ──

  async showStats() {
    const total = this.log.length;
    const open = this.log.filter((e) => e.frontmatter.status === "open").length;
    const committed = this.log.filter(
      (e) => e.frontmatter.status === "committed"
    ).length;
    const resolved = this.log.filter(
      (e) => e.frontmatter.status === "resolved"
    ).length;

    const rated = this.log.filter(
      (e) => e.frontmatter.outcome_rating !== null
    );
    const avgRating =
      rated.length > 0
        ? (
            rated.reduce((sum, e) => sum + (e.frontmatter.outcome_rating || 0), 0) /
            rated.length
          ).toFixed(1)
        : "N/A";

    const byCategory: Record<string, number> = {};
    this.log.forEach((e) => {
      const cat = e.frontmatter.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    });

    const categoryBreakdown = Object.entries(byCategory)
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join("\n");

    const statsContent = `# Seneca — Decision Stats

**Total decisions logged:** ${total}
**Open:** ${open} | **Committed:** ${committed} | **Resolved:** ${resolved}
**Average outcome rating:** ${avgRating}/10

## By Category
${categoryBreakdown}

_Run "Export log for AI analysis" for deeper pattern analysis._

_Last updated: ${moment().format("YYYY-MM-DD HH:mm")}_
`;

    const statsPath = `${this.settings.decisionsFolder}/Seneca Stats.md`;
    if (await this.app.vault.adapter.exists(statsPath)) {
      const existing = this.app.vault.getAbstractFileByPath(statsPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, statsContent);
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(existing);
      }
    } else {
      const file = await this.app.vault.create(statsPath, statsContent);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
  }

  // ── Export for AI Analysis ──

  async exportForAnalysis() {
    // Create a clean export optimized for LLM consumption
    const exportData = {
      exported_at: moment().toISOString(),
      total_decisions: this.log.length,
      decisions: this.log.map((entry) => ({
        id: entry.decision_id,
        title: entry.title,
        ...entry.frontmatter,
        activity_count: entry.activity.length,
        days_to_resolve: entry.frontmatter.date_resolved
          ? moment(entry.frontmatter.date_resolved).diff(
              moment(entry.frontmatter.date_created),
              "days"
            )
          : null,
        activity_timeline: entry.activity,
      })),
    };

    const exportPath = `${this.settings.decisionsFolder}/seneca-export.json`;
    const content = JSON.stringify(exportData, null, 2);

    if (await this.app.vault.adapter.exists(exportPath)) {
      const existing = this.app.vault.getAbstractFileByPath(exportPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      }
    } else {
      await this.app.vault.create(exportPath, content);
    }

    new Notice(`Seneca: Exported ${this.log.length} decisions to ${exportPath}`);
  }

  // ── Import Decisions ──

  async importDecisions() {
    const importPath = "seneca-import.json";

    const exists = await this.app.vault.adapter.exists(importPath);
    if (!exists) {
      new Notice(
        `Seneca: No import file found. Place a "seneca-import.json" file at your vault root and try again.`
      );
      return;
    }

    let imported: DecisionLogEntry[];
    try {
      const raw = await this.app.vault.adapter.read(importPath);
      imported = JSON.parse(raw);
    } catch (err) {
      new Notice(
        `Seneca: Failed to parse import file — ${err instanceof Error ? err.message : "unknown error"}`
      );
      return;
    }

    if (!Array.isArray(imported)) {
      new Notice("Seneca: Import file must contain a JSON array of decision entries.");
      return;
    }

    const existingIds = new Set(this.log.map((e) => e.decision_id));
    const newEntries = imported.filter((e) => !existingIds.has(e.decision_id));

    if (newEntries.length === 0) {
      new Notice(`Seneca: All ${imported.length} decisions already exist in the log. Nothing to import.`);
      return;
    }

    this.log.push(...newEntries);
    await this.saveLog();

    new Notice(
      `Seneca: Imported ${newEntries.length} new decisions (${imported.length - newEntries.length} duplicates skipped). Log now has ${this.log.length} entries.`
    );
  }

  // ── Decision Analysis ──

  async analyzeDecisions() {
    if (!this.settings.openaiApiKey) {
      new Notice("Seneca: No OpenAI API key configured. Add one in Seneca settings.");
      return;
    }

    if (this.log.length < 3) {
      new Notice(
        `Seneca: Need at least 3 decisions for analysis (currently ${this.log.length}). Log more decisions first.`
      );
      return;
    }

    new Notice(`Seneca: Analyzing ${this.log.length} decisions...`);

    const compactLog = this.log.map((e) => ({
      id: e.decision_id,
      title: e.title,
      category: e.frontmatter.category,
      status: e.frontmatter.status,
      confidence: e.frontmatter.confidence,
      stakes: e.frontmatter.stakes,
      time_pressure: e.frontmatter.time_pressure,
      emotional_state: e.frontmatter.emotional_state,
      outcome_rating: e.frontmatter.outcome_rating,
      days_to_resolve: e.frontmatter.date_resolved
        ? moment(e.frontmatter.date_resolved).diff(moment(e.frontmatter.date_created), "days")
        : null,
      created_at: e.created_at,
    }));

    let report: string;
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.settings.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(compactLog) },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      report = data.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      new Notice(
        `Seneca: Analysis failed — ${err instanceof Error ? err.message : "unknown error"}`
      );
      return;
    }

    if (!report.trim()) {
      new Notice("Seneca: Analysis returned empty. Try again later.");
      return;
    }

    report += `\n\n---\n_Generated by Seneca on ${moment().format("YYYY-MM-DD HH:mm")} from ${this.log.length} decisions._\n`;

    const analysisPath = `${this.settings.decisionsFolder}/Seneca Analysis.md`;
    if (await this.app.vault.adapter.exists(analysisPath)) {
      const existing = this.app.vault.getAbstractFileByPath(analysisPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, report);
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(existing);
      }
    } else {
      const folder = this.settings.decisionsFolder;
      if (!(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.createFolder(folder);
      }
      const file = await this.app.vault.create(analysisPath, report);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }

    new Notice("Seneca: Analysis complete.");
  }

  // ── Revisit Prompts ──

  async checkPendingRevisits() {
    const today = moment().format("YYYY-MM-DD");

    if (this.settings.lastRevisitCheck === today) return;

    this.settings.lastRevisitCheck = today;
    await this.saveSettings();

    const now = moment();
    const pending = this.log.filter((e) => {
      if (e.frontmatter.status === "resolved") return false;
      if (e.frontmatter.outcome_rating !== null) return false;
      if (!e.revisit_due) return false;
      return moment(e.revisit_due).isSameOrBefore(now, "day");
    });

    if (pending.length === 0) return;

    pending.sort((a, b) =>
      moment(a.revisit_due!).diff(moment(b.revisit_due!))
    );

    const oldest = pending[0];
    const daysOverdue = now.diff(moment(oldest.revisit_due!), "days");
    const label = oldest.title || oldest.decision_id;

    new Notice(
      `Seneca: ${pending.length} decision${pending.length > 1 ? "s" : ""} need revisiting. ` +
      `Oldest: "${label}" (${daysOverdue > 0 ? daysOverdue + "d overdue" : "due today"})`,
      10000,
    );

    // Open the oldest pending decision so the user lands on it
    const file = this.app.vault.getAbstractFileByPath(oldest.file_path);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);

      oldest.activity.push({
        type: "revisit_prompted",
        timestamp: now.toISOString(),
      });
      oldest.updated_at = now.toISOString();
      await this.saveLog();
    }
  }

  // ── Helpers ──

  isDecisionFile(file: TFile): boolean {
    return file.path.startsWith(this.settings.decisionsFolder);
  }

  async loadLog() {
    const logPath = this.settings.logFileName;

    const pathsToTry = [logPath];
    if (logPath !== "Seneca/seneca-log.json") {
      pathsToTry.push("Seneca/seneca-log.json");
    }

    for (const path of pathsToTry) {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) continue;

      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed) && parsed.length > 0) {
          this.log = parsed;
          return;
        }
      } catch {
        console.warn(`Seneca: failed to parse log at "${path}"`);
      }
    }
  }

  async saveLog() {
    const logPath = this.settings.logFileName;

    // Ensure parent folder exists
    const folder = logPath.substring(0, logPath.lastIndexOf("/"));
    if (folder && !(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }

    await this.app.vault.adapter.write(logPath, JSON.stringify(this.log, null, 2));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────

class SenecaSettingTab extends PluginSettingTab {
  plugin: SenecaPlugin;

  constructor(app: App, plugin: SenecaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Seneca — Settings" });

    new Setting(containerEl)
      .setName("Decisions folder")
      .setDesc("Where decision notes are stored in your vault.")
      .addText((text) =>
        text
          .setPlaceholder("Seneca/Decisions")
          .setValue(this.plugin.settings.decisionsFolder)
          .onChange(async (value) => {
            this.plugin.settings.decisionsFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Log file path")
      .setDesc("Path to the JSON log file that indexes all decisions.")
      .addText((text) =>
        text
          .setPlaceholder("Seneca/seneca-log.json")
          .setValue(this.plugin.settings.logFileName)
          .onChange(async (value) => {
            this.plugin.settings.logFileName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Required for voice transcription via Whisper.")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.openaiApiKey)
          .then((t) => (t.inputEl.type = "password"))
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default category")
      .setDesc("Default category for new decisions.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            product: "Product",
            technical: "Technical",
            business: "Business",
            financial: "Financial",
            personal: "Personal",
            fitness: "Fitness",
            creative: "Creative",
            other: "Other",
          })
          .setValue(this.plugin.settings.defaultCategory)
          .onChange(async (value) => {
            this.plugin.settings.defaultCategory = value as DecisionCategory;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Revisit after (days)")
      .setDesc("How many days after creation before Seneca prompts you to revisit a decision.")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.revisitDays))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.revisitDays = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
