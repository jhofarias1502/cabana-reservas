// Funções puras: iCal (ler/gerar), datas, disponibilidade e Pix (BR Code).

const DAY = 86400000;

function toISO(d) { return d.toISOString().slice(0, 10); }
function addDays(iso, n) { return toISO(new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY)); }
function nightsBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / DAY); }
function overlaps(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; } // intervalos [início, fim)

// --- iCal: leitura ---------------------------------------------------------
function parseICal(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') { if (ev && ev.start && ev.end) events.push(ev); ev = null; }
    else if (ev) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).split(';')[0].toUpperCase();
      const val = line.slice(i + 1);
      if (name === 'DTSTART') ev.start = icalDate(val);
      else if (name === 'DTEND') ev.end = icalDate(val);
      else if (name === 'UID') ev.uid = val;
      else if (name === 'SUMMARY') ev.summary = val;
    }
  }
  // Evento de um dia só sem DTEND válido: trata como 1 noite
  return events.map(e => (e.end <= e.start ? { ...e, end: addDays(e.start, 1) } : e));
}
function icalDate(v) { const m = v.match(/^(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }

// --- iCal: geração ---------------------------------------------------------
function buildICal(events, calName) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cabana//Reservas//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${calName}`];
  for (const e of events) {
    out.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${e.end.replace(/-/g, '')}`,
      `SUMMARY:${e.summary || 'Reservado'}`, 'END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

// --- Pix copia e cola (BR Code estático) -----------------------------------
function tlv(id, value) { return id + String(value.length).padStart(2, '0') + value; }
function crc16(str) {
  let crc = 0xffff;
  for (const b of Buffer.from(str, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function clean(s, max) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, max).trim(); }
function pixPayload({ key, name, city, amount, txid }) {
  const p = tlv('00', '01') +
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', key)) +
    tlv('52', '0000') + tlv('53', '986') +
    (amount ? tlv('54', amount.toFixed(2)) : '') +
    tlv('58', 'BR') + tlv('59', clean(name, 25)) + tlv('60', clean(city, 15)) +
    tlv('62', tlv('05', (txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) +
    '6304';
  return p + crc16(p);
}

module.exports = { toISO, addDays, nightsBetween, overlaps, parseICal, buildICal, pixPayload, crc16 };
