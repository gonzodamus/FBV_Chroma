'use strict';

/* ----------------------------------------------------------------------------
 * FBV Chroma LED Editor: pure Web MIDI sender.
 *
 * Protocol (see the project README):
 *   - Output port whose name contains "FBV 3". Channel 1.
 *   - Control Change. Raw bytes: [0xB0, ledIndex, value]
 *   - CC number = LED index
 *   - CC value  = state * 8 + color   (off => value 0)
 *   - CC 16: per-LED behavior. Value = ledIndex * 4 + behavior (0-3).
 *   - CC 17 = 1: commit current LED state to NVM (Feature B; pedal reboots).
 *
 * The MIDI assignment editor additionally uses the pedal's config SysEx protocol
 * (read-modify-write of the per-control assignment table). See the constants and
 * the Config SysEx helpers below.
 * -------------------------------------------------------------------------- */

const PORT_MATCH = 'FBV 3';
const CC_STATUS = 0xB0; // Control Change, channel 1
const SCENES_KEY = 'fbv3.scenes';
const LAST_KEY = 'fbv3.lastLayout';

const BEHAVIOR_CC = 16;

// CC #17 = "commit current LED state to NVM" (Feature B). The firmware packs the
// LED colors + behaviors into the config blob and calls the stock commit routine,
// which reboots the pedal. The webapp just sends one CC.
const SAVE_LED_CC = 17;

/* ---------- Config SysEx (MIDI assignment editor) ----------
 *
 * The pedal stores a per-control MIDI-assignment table in NVM and speaks it over
 * USB-MIDI SysEx (this is what Line 6's FBV Control drives). Reverse-engineered
 * frame: F0 00 01 0C 11 03 <cmd> <data..> F7.
 *
 *   READ:  F0 00 01 0C 11 03 00 00 F7
 *   reply: F0 00 01 0C 11 03 01 0A 0C <17 records x 10 bytes> <chk> F7
 *
 * Record (10 bytes) = IDX 01 00 TYPE CHAN 00 P1 P2 P3 00
 *   IDX  = control index (0x00..0x10)
 *   TYPE = assignment type (0x01 = CC; 0x02/0x03 = PgmChange/Bank-ish)
 *   CHAN = MIDI channel / sub (0x01..0x04)
 *   P1   = CC# / program ; P2 = on-value ; P3 = off-value
 *   offsets 2, 5, 9 are 0x00 in every record (spare).
 *
 * Checksum = sum(bytes from offset 6 through end-of-records) & 0x7F. Verified on
 * live dumps.
 */

// Line 6 SysEx header (the bytes between F0 and the payload). Used for both the
// request and to validate replies.
const SYSEX_HEADER = [0x00, 0x01, 0x0c, 0x11, 0x03];

const CONFIG_CMD_READ = 0x00; // host -> device: dump request
const CONFIG_CMD_REPLY = 0x01; // device -> host: dump reply

// TODO(hardware-batch): confirm on device -- see plan. The config WRITE/commit
// opcode (host -> device) is not yet confirmed. Best hypothesis: echo the dump
// reply command (0x01) back to the device. If wrong, the only change needed is
// this one constant (try 0x02). writeConfig() is built around it.
const CONFIG_WRITE_CMD = 0x01;

// Sub-header that follows the command byte in a dump reply: 0x0A = record size
// (10 bytes), 0x0C = table type/version. We echo it back on write.
const CONFIG_SUBHEADER = [0x0a, 0x0c];

const CONFIG_RECORD_LEN = 10;
const CONFIG_RECORD_COUNT = 17; // control indices 0x00..0x10
const CONFIG_CHECKSUM_OFFSET = 6; // checksum sums payload bytes from here on

const CONFIG_READ_TIMEOUT_MS = 1500;

// Assignment types we recognise in a record's TYPE field. Only CC (0x01) is
// editable here; everything else is shown read-only so we never corrupt an
// assignment we don't model.
const ASSIGN_TYPE_CC = 0x01;
const ASSIGN_TYPE_NAMES = {
  0x00: 'Unassigned',
  0x01: 'CC',
  0x02: 'Program Change',
  0x03: 'Bank',
};

// CC assignment modes offered in the editor.
const ASSIGN_MODE_SINGLE = 'single';
const ASSIGN_MODE_MOMENTARY = 'momentary';
const ASSIGN_MODE_TOGGLE = 'toggle';

const ASSIGN_MODES = [
  { id: ASSIGN_MODE_SINGLE, label: 'Single' },
  { id: ASSIGN_MODE_MOMENTARY, label: 'Momentary' },
  { id: ASSIGN_MODE_TOGGLE, label: 'Toggle' },
];

// TODO(hardware-batch): confirm on device -- see plan. How single/momentary/toggle
// map to a CC record's TYPE/CHAN/P1/P2/P3 fields is NOT yet confirmed. Hypothesis
// from one observed CC record (02 01 00 01 03 00 40 7F 40 00 = CC#0x40, P2=0x7F,
// P3=0x40): P2 is the on-value, P3 the off-value.
//   - momentary: on = 0x7F, off = 0x00 (sends 7F on press, 00 on release)
//   - toggle:    device alternates between on/off (may be a TYPE/CHAN variant; we
//                keep the same TYPE here and treat toggle as its own mode flag)
//   - single:    one fixed value (0x7F) sent on every press, no release message
// The user will finalize these from FBV Control dumps. encodeMode/decodeMode below
// are the single point that depends on this table.
const ASSIGN_ENCODING = {
  [ASSIGN_MODE_SINGLE]: { p2: 0x7f, p3: 0x7f },
  [ASSIGN_MODE_MOMENTARY]: { p2: 0x7f, p3: 0x00 },
  [ASSIGN_MODE_TOGGLE]: { p2: 0x7f, p3: 0x00 },
};

// Map the 17 control indices (0x00..0x10) to display names. 0-13 follow the LED
// map (extended past the editable LEDS table); 14-16 are unknown until the
// hardware batch decodes the control map.
// TODO(hardware-batch): confirm on device -- see plan. Indices 14-16 are guesses.
const CONFIG_CONTROL_NAMES = [
  'FS1', 'FS2', 'FS3', 'FS4', 'FS5', // 0-4
  'A', 'B', 'C', 'D', // 5-8
  'Pedal Volume', 'Pedal Wah', 'Tap Tempo', 'FUNC', 'Diagnostic', // 9-13
  'Ctrl 14', 'Ctrl 15', 'Ctrl 16', // 14-16 (unknown)
];

// Current firmware build this editor targets. Auto-detecting the pedal's
// version over USB-MIDI is unreliable, so we show the version (see #versionNote)
// as guidance for users to self-check and update. An older pedal will not
// understand the per-LED behavior CCs. Bump alongside patch.js and
// build_firmware.py.
const FW_VERSION = 'FBV Chroma 1.2';
const FW_UPDATER_VERSION = '1.20.00';

const STATE_OFF = 0;
const STATE_STEADY = 1;
const STATE_BLINK = 2;

// Editor state options. STATE_OFF is still used internally (default, "Off"
// button, presets) but is not offered as a per-LED choice here.
const STATES = [
  { id: STATE_STEADY, label: 'Steady' },
  { id: STATE_BLINK, label: 'Blink' },
];

// color id = low 3 bits of the CC value. `css` is for the on-screen lamp/swatch.
const COLORS = [
  { id: 0, name: 'Red', css: '#ff453a' },
  { id: 1, name: 'Green', css: '#30d158' },
  { id: 2, name: 'Blue', css: '#0a84ff' },
  { id: 3, name: 'Cyan', css: '#2dd4d4' },
  { id: 4, name: 'Yellow', css: '#ffd60a' },
  { id: 5, name: 'Pink', css: '#ff2d95' },
  { id: 6, name: 'Orange', css: '#ff9f0a' },
  { id: 7, name: 'White', css: '#f2f2f7' },
];

// Per-LED behavior codes. The firmware resets every LED to behavior 0 on
// power-up. behavior 0 is also the webapp default.
const BEHAVIORS = [
  { id: 0, label: 'On at rest' },
  { id: 1, label: 'On when pressed' },
  { id: 2, label: 'Always on' },
  { id: 3, label: 'Always off' },
];

// LEDs to control; index === CC number (not contiguous). On-screen placement
// is driven by PAD_ROWS below.
const LEDS = [
  { idx: 0, name: 'FS1' },
  { idx: 1, name: 'FS2' },
  { idx: 2, name: 'FS3' },
  { idx: 3, name: 'FS4' },
  { idx: 4, name: 'FS5' },
  { idx: 5, name: 'A' },
  { idx: 6, name: 'B' },
  { idx: 7, name: 'C' },
  { idx: 8, name: 'D' },
  { idx: 12, name: 'FUNC' },
];

const LED_BY_IDX = {};
LEDS.forEach((led) => {
  LED_BY_IDX[led.idx] = led;
});

// Pedalboard layout: one array per row, holding LED indices. `'blank'` leaves an
// empty slot. Top row is FS1-FS5, a gap, then FUNC in the 7th slot.
const PAD_ROWS = [
  [0, 1, 2, 3, 4, 'blank', 12],
  [5, 6, 7, 8],
];

// Authoritative model: the firmware holds whatever we last sent, so what is
// on screen is what is on the pedal. Keyed by LED index (=== CC number);
// indices are not contiguous, so this is an object rather than an array.
const model = {};
LEDS.forEach((led) => {
  model[led.idx] = { state: STATE_OFF, color: 1 /* green */, behavior: 0 };
});

let midiAccess = null;
let outputPort = null;
let inputPort = null;

// Pending readConfig() promise resolver, set while a dump request is in flight.
let pendingConfigRead = null;

// Last parsed assignment records (array of {idx,type,chan,p1,p2,p3}), or null
// before the first successful read.
let configRecords = null;

// DOM refs filled in on load.
const dom = {};

/* ---------- Protocol helpers ---------- */

function ccValue(led) {
  return led.state === STATE_OFF ? 0 : led.state * 8 + led.color;
}

function sendLed(idx) {
  const value = ccValue(model[idx]);
  if (outputPort) {
    try {
      outputPort.send([CC_STATUS, idx, value]);
    } catch (err) {
      console.error(`MIDI send failed for LED ${idx}`, err);
    }
  }
  return value;
}

function sendBehavior(idx) {
  if (outputPort) {
    try {
      outputPort.send([CC_STATUS, BEHAVIOR_CC, idx * 4 + model[idx].behavior]);
    } catch (err) {
      console.error(`MIDI send failed for behavior on LED ${idx}`, err);
    }
  }
}

function sendAll() {
  LEDS.forEach((led) => sendLed(led.idx));
}

function sendAllBehaviors() {
  LEDS.forEach((led) => sendBehavior(led.idx));
}

// Feature B: tell the pedal to commit the current LED state to NVM (CC #17).
// The firmware reboots after saving.
function sendSaveLeds() {
  if (!outputPort) return false;
  try {
    outputPort.send([CC_STATUS, SAVE_LED_CC, 1]);
    return true;
  } catch (err) {
    console.error('MIDI send failed for LED save', err);
    return false;
  }
}

/* ---------- Config SysEx helpers ---------- */

// Wrap data bytes in a SysEx frame and send. `dataBytes` excludes F0/F7.
function sendSysex(dataBytes) {
  if (!outputPort) return false;
  try {
    outputPort.send([0xf0, ...dataBytes, 0xf7]);
    return true;
  } catch (err) {
    console.error('MIDI SysEx send failed', err);
    return false;
  }
}

// Compute the config checksum: sum of payload bytes from CONFIG_CHECKSUM_OFFSET
// through the end of the records, masked to 7 bits. `payloadBytes` is the data
// between F0 and F7 (header + subheader + records), excluding the checksum byte.
function configChecksum(payloadBytes) {
  let sum = 0;
  for (let i = CONFIG_CHECKSUM_OFFSET; i < payloadBytes.length; i++) {
    sum += payloadBytes[i];
  }
  return sum & 0x7f;
}

// Parse a full dump reply (the raw bytes including F0..F7, or just the data
// bytes) into an array of records. Returns null if it isn't a valid reply.
function parseConfig(replyBytes) {
  let b = Array.from(replyBytes);
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);

  // Expect header + reply command.
  for (let i = 0; i < SYSEX_HEADER.length; i++) {
    if (b[i] !== SYSEX_HEADER[i]) return null;
  }
  let off = SYSEX_HEADER.length;
  if (b[off] !== CONFIG_CMD_REPLY) return null;
  off += 1;

  // Sub-header (0A 0C).
  for (let i = 0; i < CONFIG_SUBHEADER.length; i++) {
    if (b[off + i] !== CONFIG_SUBHEADER[i]) return null;
  }
  off += CONFIG_SUBHEADER.length;

  const records = [];
  for (let r = 0; r < CONFIG_RECORD_COUNT; r++) {
    const base = off + r * CONFIG_RECORD_LEN;
    if (base + CONFIG_RECORD_LEN > b.length) break;
    records.push({
      idx: b[base + 0],
      type: b[base + 3],
      chan: b[base + 4],
      p1: b[base + 6],
      p2: b[base + 7],
      p3: b[base + 8],
    });
  }
  return records;
}

// Reassemble the full data byte array (between F0 and F7) from records:
// header + reply/write command + 0A 0C + records + checksum.
function buildConfig(records) {
  const payload = [...SYSEX_HEADER, CONFIG_WRITE_CMD, ...CONFIG_SUBHEADER];
  for (const rec of records) {
    payload.push(
      rec.idx & 0x7f,
      0x01,
      0x00,
      rec.type & 0x7f,
      rec.chan & 0x7f,
      0x00,
      rec.p1 & 0x7f,
      rec.p2 & 0x7f,
      rec.p3 & 0x7f,
      0x00
    );
  }
  payload.push(configChecksum(payload));
  return payload;
}

// Send the dump request and resolve with the parsed records when the reply
// arrives on the input port. Rejects on timeout or if no port is connected.
function readConfig() {
  return new Promise((resolve, reject) => {
    if (!outputPort) {
      reject(new Error('No pedal connected'));
      return;
    }
    if (!inputPort) {
      reject(new Error('No FBV 3 MIDI input port (cannot receive a config dump)'));
      return;
    }
    if (pendingConfigRead) {
      reject(new Error('A config read is already in progress'));
      return;
    }

    const timer = setTimeout(() => {
      pendingConfigRead = null;
      reject(new Error('Timed out waiting for the pedal to reply'));
    }, CONFIG_READ_TIMEOUT_MS);

    pendingConfigRead = (records) => {
      clearTimeout(timer);
      pendingConfigRead = null;
      resolve(records);
    };

    // Dump request: cmd 0x00, one (ignored) page byte.
    sendSysex([...SYSEX_HEADER, CONFIG_CMD_READ, 0x00]);
  });
}

// Write the assignment table back to the pedal. Warns the caller that the pedal
// reboots after a commit (the firmware restarts on a successful config save).
function writeConfig(records) {
  if (!outputPort) return false;
  return sendSysex(buildConfig(records));
}

// Inbound MIDI handler: resolve a pending readConfig() when a dump reply lands.
function onMidiMessage(event) {
  const data = event.data;
  if (!data || data[0] !== 0xf0) return; // only care about SysEx
  const records = parseConfig(data);
  if (records && pendingConfigRead) {
    pendingConfigRead(records);
  }
}

/* ---------- MIDI setup ---------- */

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setStatus('error', 'Web MIDI not supported');
    showBanner(
      '<strong>This browser has no Web MIDI.</strong> Open this page in ' +
        '<strong>Chrome</strong> or <strong>Edge</strong> (desktop). Safari and Firefox ' +
        'do not support the Web MIDI API.'
    );
    return;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  } catch (err) {
    setStatus('error', 'MIDI access denied');
    showBanner(
      '<strong>Could not get MIDI access.</strong> Allow the MIDI permission and reload. ' +
        'Web MIDI also requires a secure context: serve this over <code>https</code> or ' +
        '<code>http://localhost</code>, not <code>file://</code>. ' +
        `<br>Details: ${escapeHtml(String(err && err.message ? err.message : err))}`
    );
    return;
  }

  midiAccess.onstatechange = () => { findPort(); };
  findPort();
}

function findPort() {
  const prevId = outputPort ? outputPort.id : null;
  let found = null;
  for (const out of midiAccess.outputs.values()) {
    if (out.name && out.name.includes(PORT_MATCH)) {
      found = out;
      break;
    }
  }

  outputPort = found;

  // Also grab the matching input port so we can receive config-dump replies.
  // The app was output-only before the assignment editor.
  let foundIn = null;
  for (const inp of midiAccess.inputs.values()) {
    if (inp.name && inp.name.includes(PORT_MATCH)) {
      foundIn = inp;
      break;
    }
  }
  if (inputPort && inputPort !== foundIn) inputPort.onmidimessage = null;
  inputPort = foundIn;
  if (inputPort) inputPort.onmidimessage = onMidiMessage;

  if (found) {
    setStatus('ok', `Connected: ${found.name}`);
    hideBanner();
    // Newly (re)connected: push all LED states + behaviors so the pedal matches.
    if (found.id !== prevId) {
      sendAll();
      sendAllBehaviors();
    }
  } else {
    setStatus('pending', 'Pedal not found');
    showBanner(
      `<strong>No "${PORT_MATCH}" MIDI output found.</strong> Connect the FBV3 by USB ` +
        `(it must be running the patched firmware, <code>${FW_VERSION}</code>). ` +
        'It will be detected automatically when it appears, no reload needed.'
    );
  }
}

/* ---------- Status / banner ---------- */

function setStatus(kind, text) {
  dom.status.className = `status status--${kind}`;
  dom.status.querySelector('.status__text').textContent = text;
}

function showBanner(html) {
  dom.banner.innerHTML = html;
  dom.banner.hidden = false;
}

function hideBanner() {
  dom.banner.hidden = true;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ---------- Rendering ---------- */

// The LED currently being edited (its index, === CC number).
let selectedIdx = LEDS[0].idx;

function buildBoard() {
  dom.board.innerHTML = '';
  dom.board.appendChild(buildPedalboard());
  dom.board.appendChild(buildEditor());
}

function buildPedalboard() {
  const board = document.createElement('div');
  board.className = 'pedalboard';

  // Flattened into the 7-column grid. The first row fills all 7 columns (incl.
  // the blank), so the second row (A-D) wraps cleanly underneath.
  for (const row of PAD_ROWS) {
    for (const item of row) {
      if (item === 'blank') {
        const blank = document.createElement('span');
        blank.className = 'pad-blank';
        board.appendChild(blank);
        continue;
      }
      board.appendChild(buildPad(LED_BY_IDX[item]));
    }
  }
  return board;
}

function buildPad(led) {
  const pad = document.createElement('button');
  pad.className = 'pad';
  pad.dataset.idx = led.idx;
  pad.title = `${led.name} (CC ${led.idx})`;
  pad.addEventListener('click', () => select(led.idx));

  const lamp = document.createElement('span');
  lamp.className = 'lamp pad__lamp';
  pad.appendChild(lamp);

  const label = document.createElement('span');
  label.className = 'pad__label';
  label.textContent = led.name;
  pad.appendChild(label);

  return pad;
}

// The single shared editor: swatches + state + behavior, applied to the selected LED.
function buildEditor() {
  const editor = document.createElement('div');
  editor.className = 'editor';

  const head = document.createElement('div');
  head.className = 'editor__head';
  head.innerHTML =
    '<span class="editor__title">Editing</span>' +
    '<span id="editName" class="editor__name"></span>' +
    '<span id="editCC" class="editor__cc"></span>';
  editor.appendChild(head);

  const row = document.createElement('div');
  row.className = 'editor__row';

  const swatches = document.createElement('div');
  swatches.className = 'swatches editor__swatches';
  for (const color of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.style.background = color.css;
    sw.dataset.color = color.id;
    sw.title = color.name;
    sw.setAttribute('aria-label', color.name);
    sw.addEventListener('click', () => onColorPick(selectedIdx, color.id));
    swatches.appendChild(sw);
  }
  row.appendChild(swatches);

  const states = document.createElement('div');
  states.className = 'states editor__states';
  for (const st of STATES) {
    const btn = document.createElement('button');
    btn.className = 'state-btn';
    btn.dataset.state = st.id;
    btn.textContent = st.label;
    btn.addEventListener('click', () => onStatePick(selectedIdx, st.id));
    states.appendChild(btn);
  }
  row.appendChild(states);

  // Behavior selector: 4 segmented buttons.
  const behaviors = document.createElement('div');
  behaviors.className = 'states editor__behaviors';
  for (const bv of BEHAVIORS) {
    const btn = document.createElement('button');
    btn.className = 'state-btn';
    btn.dataset.behavior = bv.id;
    btn.textContent = bv.label;
    btn.addEventListener('click', () => onBehaviorPick(selectedIdx, bv.id));
    behaviors.appendChild(btn);
  }
  row.appendChild(behaviors);

  editor.appendChild(row);
  return editor;
}

function refreshPad(idx) {
  const lamp = dom.board.querySelector(`.pad[data-idx="${idx}"] .pad__lamp`);
  if (!lamp) return;
  const m = model[idx];
  lamp.classList.toggle('lamp--on', m.state !== STATE_OFF);
  lamp.classList.toggle('lamp--blink', m.state === STATE_BLINK);
  lamp.style.setProperty('--glow', m.state === STATE_OFF ? 'transparent' : COLORS[m.color].css);
}

function refreshEditor() {
  const led = LED_BY_IDX[selectedIdx];
  const m = model[selectedIdx];

  dom.board.querySelectorAll('.pad').forEach((pad) => {
    pad.classList.toggle('pad--selected', Number(pad.dataset.idx) === selectedIdx);
  });

  document.getElementById('editName').textContent = led.name;
  document.getElementById('editCC').textContent = `CC ${selectedIdx}`;

  dom.board.querySelectorAll('.editor__swatches .swatch').forEach((sw) => {
    sw.classList.toggle('swatch--active', Number(sw.dataset.color) === m.color);
  });
  dom.board.querySelectorAll('.editor__states .state-btn').forEach((btn) => {
    btn.classList.toggle('state-btn--active', Number(btn.dataset.state) === m.state);
  });
  dom.board.querySelectorAll('.editor__behaviors .state-btn').forEach((btn) => {
    btn.classList.toggle('state-btn--active', Number(btn.dataset.behavior) === m.behavior);
  });
}

function refreshAll() {
  LEDS.forEach((led) => refreshPad(led.idx));
  refreshEditor();
}

/* ---------- Interaction ---------- */

function select(idx) {
  selectedIdx = idx;
  refreshEditor();
}

function onColorPick(idx, colorId) {
  const led = model[idx];
  led.color = colorId;
  // Picking a color while off implies "turn it on": promote to steady so the
  // click produces visible feedback.
  if (led.state === STATE_OFF) led.state = STATE_STEADY;
  commit(idx);
}

function onStatePick(idx, stateId) {
  model[idx].state = stateId;
  commit(idx);
}

function onBehaviorPick(idx, behaviorId) {
  model[idx].behavior = behaviorId;
  sendBehavior(idx);
  if (idx === selectedIdx) refreshEditor();
  saveLast();
}

// Apply one LED: update its lamp + the editor, push to the pedal, and persist.
function commit(idx) {
  refreshPad(idx);
  if (idx === selectedIdx) refreshEditor();
  sendLed(idx);
  // A color/state CC sets the LED on/off directly, which would re-light an
  // "Always off" LED (or vice versa) until the next footswitch press. For the
  // absolute behaviors, re-assert so the LED settles to its behavior right away.
  if (model[idx].behavior >= 2) sendBehavior(idx);
  saveLast();
}

// Load a saved layout array into the model (no rendering/sending). Tolerates
// older scenes that lack an explicit idx by falling back to position.
function applyLayoutToModel(layout) {
  if (!Array.isArray(layout)) return;
  layout.forEach((s, i) => {
    const idx = s && Number.isInteger(s.idx) ? s.idx : LEDS[i] && LEDS[i].idx;
    if (idx == null || !model[idx]) return;
    model[idx].state = clampState(s.state);
    model[idx].color = clampColor(s.color);
    model[idx].behavior = clampBehavior(s.behavior);
  });
}

function setLayout(layout, { send }) {
  applyLayoutToModel(layout);
  refreshAll();
  saveLast();
  if (send) {
    sendAll();
    sendAllBehaviors();
  }
}

/* ---------- Presets ---------- */

function applyPreset(name) {
  if (name === 'rainbow') {
    // Spread the 8 colors across the LEDs, steady.
    setLayout(
      LEDS.map((led, i) => ({ idx: led.idx, state: STATE_STEADY, color: i % COLORS.length })),
      { send: true }
    );
  } else if (name === 'white') {
    setLayout(LEDS.map((led) => ({ idx: led.idx, state: STATE_STEADY, color: 7 })), {
      send: true,
    });
  }
}

/* ---------- Scenes (localStorage) ---------- */

function getScenes() {
  try {
    const raw = localStorage.getItem(SCENES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function putScenes(scenes) {
  localStorage.setItem(SCENES_KEY, JSON.stringify(scenes));
}

function snapshot() {
  return LEDS.map((led) => ({
    idx: led.idx,
    state: model[led.idx].state,
    color: model[led.idx].color,
    behavior: model[led.idx].behavior,
  }));
}

// Render one chip per saved scene, inline with the presets. Clicking the name
// applies the scene; the x deletes it.
function renderScenes() {
  const scenes = getScenes();
  const names = Object.keys(scenes).sort((a, b) => a.localeCompare(b));
  const wrap = dom.sceneChips;
  wrap.innerHTML = '';

  for (const name of names) {
    const chip = document.createElement('span');
    chip.className = 'chip';

    const apply = document.createElement('button');
    apply.className = 'btn chip__apply';
    apply.textContent = name;
    apply.title = `Apply scene "${name}"`;
    apply.addEventListener('click', () => applyScene(name));

    const del = document.createElement('button');
    del.className = 'chip__del';
    del.textContent = '\xd7';
    del.title = `Delete scene "${name}"`;
    del.setAttribute('aria-label', `Delete scene ${name}`);
    del.addEventListener('click', () => deleteScene(name));

    chip.appendChild(apply);
    chip.appendChild(del);
    wrap.appendChild(chip);
  }
}

function saveScene() {
  const name = prompt('Save current layout as:', '');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;

  const scenes = getScenes();
  if (scenes[trimmed] && !confirm(`Overwrite scene "${trimmed}"?`)) return;

  scenes[trimmed] = snapshot();
  putScenes(scenes);
  renderScenes();
}

function applyScene(name) {
  const scenes = getScenes();
  const layout = scenes[name];
  if (!Array.isArray(layout)) return;
  setLayout(layout, { send: true });
}

function deleteScene(name) {
  if (!confirm(`Delete scene "${name}"?`)) return;
  const scenes = getScenes();
  delete scenes[name];
  putScenes(scenes);
  renderScenes();
}

/* ---------- Apply-to-all behavior ---------- */

function applyBehaviorToAll(behaviorId) {
  LEDS.forEach((led) => {
    model[led.idx].behavior = behaviorId;
    sendBehavior(led.idx);
  });
  refreshEditor();
  saveLast();
}

/* ---------- Last-layout persistence (survive reload) ---------- */

function saveLast() {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(snapshot()));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

function loadLast() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (raw) applyLayoutToModel(JSON.parse(raw));
  } catch {
    /* ignore malformed data */
  }
}

/* ---------- Validation ---------- */

function clampState(v) {
  v = Number(v);
  return v === STATE_STEADY || v === STATE_BLINK ? v : STATE_OFF;
}

function clampColor(v) {
  v = Number(v);
  return Number.isInteger(v) && v >= 0 && v <= 7 ? v : 0;
}

function clampBehavior(v) {
  v = Number(v);
  return Number.isInteger(v) && v >= 0 && v <= 3 ? v : 0;
}

/* ---------- Assignment editor (MIDI assignments over config SysEx) ---------- */

// Derive a CC mode (single / momentary / toggle) from a record's P2/P3 values.
// Mirrors ASSIGN_ENCODING; falls back to momentary for unrecognised pairs.
// TODO(hardware-batch): confirm on device -- see plan. Toggle vs single may need
// a TYPE/CHAN distinction we can't see yet.
function decodeMode(rec) {
  if (rec.p3 === rec.p2) return ASSIGN_MODE_SINGLE;
  if (rec.p3 === 0x00) return ASSIGN_MODE_MOMENTARY;
  return ASSIGN_MODE_MOMENTARY;
}

// Apply a chosen mode to a record's P2/P3 (in place).
function encodeMode(rec, mode) {
  const enc = ASSIGN_ENCODING[mode] || ASSIGN_ENCODING[ASSIGN_MODE_MOMENTARY];
  rec.p2 = enc.p2;
  rec.p3 = enc.p3;
  rec.mode = mode;
}

function controlName(idx) {
  return CONFIG_CONTROL_NAMES[idx] || `Ctrl ${idx}`;
}

function typeName(type) {
  return ASSIGN_TYPE_NAMES[type] || `Type 0x${type.toString(16)}`;
}

// Build the assignment editor panel. It is empty (just a Read button + hint)
// until a dump is read from the pedal.
function buildAssignPanel() {
  const card = document.createElement('section');
  card.className = 'assign';

  const head = document.createElement('div');
  head.className = 'assign__head';
  head.innerHTML =
    '<h2 class="assign__title">MIDI assignments</h2>' +
    '<p class="assign__sub">What each control sends. Read the current table from the ' +
    'pedal, edit a CC assignment, then write it back. <strong>Writing reboots the ' +
    'pedal.</strong></p>';
  card.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'assign__actions';

  const readBtn = document.createElement('button');
  readBtn.id = 'assignRead';
  readBtn.className = 'btn';
  readBtn.textContent = 'Read from pedal';
  actions.appendChild(readBtn);

  const writeBtn = document.createElement('button');
  writeBtn.id = 'assignWrite';
  writeBtn.className = 'btn btn--primary';
  writeBtn.textContent = 'Write to pedal';
  writeBtn.disabled = true;
  actions.appendChild(writeBtn);

  const msg = document.createElement('span');
  msg.id = 'assignMsg';
  msg.className = 'assign__msg';
  actions.appendChild(msg);

  card.appendChild(actions);

  const rows = document.createElement('div');
  rows.id = 'assignRows';
  rows.className = 'assign__rows';
  card.appendChild(rows);

  return card;
}

function setAssignMsg(text, kind) {
  if (!dom.assignMsg) return;
  dom.assignMsg.textContent = text || '';
  dom.assignMsg.className = 'assign__msg' + (kind ? ` assign__msg--${kind}` : '');
}

// Render the records table from `configRecords`. CC records are editable;
// everything else is read-only.
function renderAssignRows() {
  const wrap = dom.assignRows;
  wrap.innerHTML = '';
  if (!configRecords) return;

  for (const rec of configRecords) {
    const row = document.createElement('div');
    row.className = 'assign-row';

    const name = document.createElement('span');
    name.className = 'assign-row__name';
    name.textContent = controlName(rec.idx);
    row.appendChild(name);

    if (rec.type !== ASSIGN_TYPE_CC) {
      row.classList.add('assign-row--ro');
      const ro = document.createElement('span');
      ro.className = 'assign-row__ro';
      ro.textContent = typeName(rec.type);
      row.appendChild(ro);
      wrap.appendChild(row);
      continue;
    }

    // CC number input.
    const ccWrap = document.createElement('label');
    ccWrap.className = 'assign-row__cc';
    ccWrap.append('CC ');
    const cc = document.createElement('input');
    cc.type = 'number';
    cc.min = '0';
    cc.max = '127';
    cc.value = String(rec.p1);
    cc.className = 'assign-row__num';
    cc.addEventListener('change', () => {
      let v = parseInt(cc.value, 10);
      if (!Number.isInteger(v)) v = 0;
      v = Math.max(0, Math.min(127, v));
      cc.value = String(v);
      rec.p1 = v;
    });
    ccWrap.appendChild(cc);
    row.appendChild(ccWrap);

    // Mode selector (single / momentary / toggle).
    const modes = document.createElement('div');
    modes.className = 'states assign-row__modes';
    const current = rec.mode || decodeMode(rec);
    for (const m of ASSIGN_MODES) {
      const btn = document.createElement('button');
      btn.className = 'state-btn';
      btn.dataset.mode = m.id;
      btn.textContent = m.label;
      btn.classList.toggle('state-btn--active', m.id === current);
      btn.addEventListener('click', () => {
        encodeMode(rec, m.id);
        modes.querySelectorAll('.state-btn').forEach((b) => {
          b.classList.toggle('state-btn--active', b.dataset.mode === m.id);
        });
      });
      modes.appendChild(btn);
    }
    rec.mode = current;
    row.appendChild(modes);

    wrap.appendChild(row);
  }
}

async function onAssignRead() {
  if (!outputPort) {
    setAssignMsg('Pedal not connected.', 'error');
    return;
  }
  setAssignMsg('Reading...', null);
  try {
    const records = await readConfig();
    records.forEach((rec) => {
      if (rec.type === ASSIGN_TYPE_CC) rec.mode = decodeMode(rec);
    });
    configRecords = records;
    renderAssignRows();
    if (dom.assignWrite) dom.assignWrite.disabled = false;
    setAssignMsg(`Read ${records.length} assignments.`, 'ok');
  } catch (err) {
    setAssignMsg(err && err.message ? err.message : String(err), 'error');
  }
}

function onAssignWrite() {
  if (!configRecords) return;
  if (
    !confirm(
      'Write the assignment table to the pedal?\n\n' +
        'The pedal will REBOOT after saving. Any unsaved LED changes are kept ' +
        '(they live in the app and re-send on reconnect).'
    )
  ) {
    return;
  }
  const ok = writeConfig(configRecords);
  setAssignMsg(
    ok ? 'Write sent. The pedal is rebooting...' : 'Write failed (no pedal).',
    ok ? 'ok' : 'error'
  );
}

/* ---------- Wire up ---------- */

function init() {
  dom.status = document.getElementById('status');
  dom.banner = document.getElementById('banner');
  dom.board = document.getElementById('board');
  dom.behaviorSelect = document.getElementById('behaviorSelect');
  dom.applyBehaviorAll = document.getElementById('applyBehaviorAll');
  dom.sceneChips = document.getElementById('sceneChips');
  dom.saveScene = document.getElementById('saveScene');
  dom.saveLeds = document.getElementById('saveLeds');
  dom.assignPanel = document.getElementById('assignPanel');
  dom.versionNote = document.getElementById('versionNote');

  dom.versionNote.innerHTML =
    `Latest firmware: <strong>${FW_VERSION}</strong> ` +
    `(Line 6 Updater shows ${FW_UPDATER_VERSION}; the pedal shows it on screen at startup). ` +
    `On an older version? Per-LED behavior needs ${FW_VERSION}: rebuild below and reflash.`;

  loadLast();
  buildBoard();
  refreshAll();
  renderScenes();

  dom.applyBehaviorAll.addEventListener('click', () => {
    const behaviorId = Number(dom.behaviorSelect.value);
    applyBehaviorToAll(behaviorId);
  });
  dom.saveScene.addEventListener('click', saveScene);

  // Feature B: save LED settings to the pedal's NVM (CC #17, reboots the pedal).
  if (dom.saveLeds) {
    dom.saveLeds.addEventListener('click', () => {
      if (!outputPort) {
        alert('Pedal not connected.');
        return;
      }
      if (
        !confirm(
          'Save the current LED colors and behaviors to the pedal so they ' +
            'survive a power-cycle?\n\nThe pedal will RESTART after saving.'
        )
      ) {
        return;
      }
      sendSaveLeds();
    });
  }

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // Assignment editor panel.
  if (dom.assignPanel) {
    dom.assignPanel.appendChild(buildAssignPanel());
    dom.assignRows = document.getElementById('assignRows');
    dom.assignMsg = document.getElementById('assignMsg');
    dom.assignWrite = document.getElementById('assignWrite');
    document.getElementById('assignRead').addEventListener('click', onAssignRead);
    dom.assignWrite.addEventListener('click', onAssignWrite);
  }

  initBuilder();
  initMidi();
}

/* ---------- Firmware builder (in-browser patcher) ---------- */

function initBuilder() {
  const input = document.getElementById('fwFile');
  const msg = document.getElementById('builderMsg');
  if (!input || !msg) return;

  if (!browserCanPatch()) {
    msg.textContent =
      'This browser cannot build firmware (no compression API). Use Chrome or Edge, ' +
      'or run manual/build/build_firmware.py instead.';
    msg.className = 'builder__msg builder__msg--error';
    input.disabled = true;
    return;
  }

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    msg.textContent = `Building from ${file.name}...`;
    msg.className = 'builder__msg';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await patchFirmware(bytes);
      downloadBlob(result.blob, result.name);
      msg.textContent = `Done. ${result.name} downloaded. Flash it with the Line 6 FBV3 Updater (update from a file).`;
      msg.className = 'builder__msg builder__msg--ok';
    } catch (err) {
      msg.textContent = err && err.message ? err.message : String(err);
      msg.className = 'builder__msg builder__msg--error';
    } finally {
      input.value = ''; // allow re-picking the same file
    }
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('DOMContentLoaded', init);
