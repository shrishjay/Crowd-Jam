'use strict';
// Every client message is validated here. Clients may only send a tiny gesture vocabulary: never notes, frequencies or instruments.
const INPUTS = new Set(['tap', 'hold_start', 'hold_update', 'hold_end', 'shake', 'tilt']);
const HOST_ACTIONS = new Set(['start', 'pause', 'resume', 'end', 'advance_round', 'set_master_volume']);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function validateGesture(m) {
  if (!m || m.type !== 'gesture' || !INPUTS.has(m.inputId)) return null;
  if (!Number.isSafeInteger(m.clientSequence) || m.clientSequence < 0) return null;
  if (m.clientTimeMs !== undefined && !finite(m.clientTimeMs)) return null;
  if (m.value !== undefined && (!finite(m.value) || m.value < 0 || m.value > 1)) return null;
  if (m.durationMs !== undefined && (!finite(m.durationMs) || m.durationMs < 0 || m.durationMs > 60000)) return null;
  if (m.motion !== undefined) {
    const o = m.motion;
    if (!o || typeof o !== 'object') return null;
    for (const k of ['x', 'y', 'z']) if (o[k] !== undefined && (!finite(o[k]) || o[k] < -1 || o[k] > 1)) return null;
  }
  return { inputId: m.inputId, clientSequence: m.clientSequence, value: m.value, durationMs: m.durationMs };
}
function validateHostControl(m) {
  return m && m.type === 'host_control' && HOST_ACTIONS.has(m.action) ? { action: m.action, preset: ['RADIANT', 'CINEMATIC', 'PLAYFUL'].includes(m.preset) ? m.preset : undefined } : null;
}
function parse(raw) { try { const m = JSON.parse(raw); return m && typeof m === 'object' && typeof m.type === 'string' ? m : null; } catch { return null; } }

module.exports = { validateGesture, validateHostControl, parse, INPUTS };
