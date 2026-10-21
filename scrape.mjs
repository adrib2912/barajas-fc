// Lee de la RFFM los partidos de todos los equipos del C.D. Barajas (todas las categorías)
// y guarda en data.json los del fin de semana actual y los dos siguientes, con día, hora y campo.
// Si algo sale raro, NO estropea data.json: conserva lo anterior y deja pistas en debug/.
import { chromium } from "playwright";
import fs from "node:fs";

const CLUB = "42740";            // código del C.D. Barajas en la RFFM (sale en la dirección de su escudo)
const TEMP = "22";               // temporada 2026-2027 en la RFFM
// Grupos que se leen siempre, aunque no salgan en la ficha del club (por si acaso)
const GRUPOS_FIJOS = [
  { tipojuego: "2", competicion: "26738230", grupo: "26738231" }, // Femenino senior F7
];
const BASE = "https://www.rffm.es";
const DEBUG = "debug";
const RAPIDA = (process.env.MODO || "completa") === "rapida";
const INICIO = Date.now();
const minutos = () => (Date.now() - INICIO) / 60000;
const LIMITE = +(process.env.MINUTOS || 25);
fs.mkdirSync(DEBUG, { recursive: true });

const LOG = [];
for (const k of ["log", "error"]) {
  const orig = console[k];
  console[k] = (...a) => { LOG.push(a.join(" ")); orig(...a); fs.writeFileSync(`${DEBUG}/log.txt`, LOG.join("\n")); };
}

// ---------- FECHAS (hora de Madrid) ----------
const hoyMadrid = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
const sumaDias = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const diaSemana = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const HOY = hoyMadrid();
const LUNES = sumaDias(HOY, -((diaSemana(HOY) + 6) % 7));
const DESDE = sumaDias(LUNES, -1);   // por si alguna jornada lleva fecha de domingo anterior
const HASTA = sumaDias(LUNES, 20);   // este fin de semana y los dos siguientes
// La RFFM publica los horarios oficiales el lunes de la semana del partido a las 9:00
function yaOficial(fecha) {
  if (!fecha) return false;
  const lunes = sumaDias(fecha, -((diaSemana(fecha) + 6) % 7));
  const [y, m, d] = lunes.split("-").map(Number);
  return Date.now() >= Date.UTC(y, m - 1, d, 8, 0);
}

// ---------- DATOS ANTERIORES ----------
let previo = {};
try { previo = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch {}
const actas = previo.actas || {}; // caché de lo leído en cada acta

// ---------- NAVEGADOR ----------
let browser;
try { browser = await chromium.launch(process.env.CANAL ? { channel: process.env.CANAL } : {}); }
catch (e) { console.error("No se pudo abrir", process.env.CANAL, "- uso Chromium:", e.message.split("\n")[0]); browser = await chromium.launch(); }
console.log(`Modo ${RAPIDA ? "rápido" : "completo"} · semana del ${LUNES} · ventana ${DESDE} a ${HASTA}`);
const page = await browser.newPage({
  locale: "es-ES",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
});
await page.route("**/*", (route) => {
  const req = route.request();
  const host = new URL(req.url()).hostname;
  if (!host.endsWith("rffm.es") || ["image", "media", "font"].includes(req.resourceType())) return route.abort();
  return route.continue();
});
// Respuestas JSON internas de la web (pistas para mejorar esto)
const APIS = [];
page.on("response", async (r) => {
  const ct = r.headers()["content-type"] || "";
  if (!ct.includes("json") || !r.url().includes("rffm.es/api")) return;
  try { APIS.push({ url: r.url(), body: await r.json() }); } catch {}
});
const api = async (ruta) => {
  const txt = await page.evaluate(async (r) => { const x = await fetch(r, { headers: { accept: "application/json" } }); return x.status + " " + (await x.text()); }, ruta);
  const sp = txt.indexOf(" ");
  try { return JSON.parse(txt.slice(sp + 1)); } catch { throw new Error(`${ruta} -> ${txt.slice(0, 200)}`); }
};
const vuelca = async (nombre) => {
  try {
    fs.writeFileSync(`${DEBUG}/${nombre}.txt`, page.url() + "\n\n" + (await page.evaluate(() => document.body.innerText)));
    fs.writeFileSync(`${DEBUG}/${nombre}.html`, await page.content());
  } catch {}
};

// ---------- 1. EQUIPOS DEL CLUB Y SUS GRUPOS ----------
// Se buscan en la ficha del club y en la de cada equipo. Solo en modo completo o si aún no hay lista.
let equipos = previo.equipos || [];
let grupos = previo.grupos || []; // [{tipojuego, competicion, grupo, comp, nombreGrupo, equipo}]
const clave = (g) => `${g.competicion}-${g.grupo}`;

async function descubrir() {
  await page.goto(`${BASE}/fichaclub/${CLUB}?temporada=${TEMP}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('a[href*="/fichaequipo/"]').length > 0, null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await vuelca("club");
  const html = await page.content();
  const vistos = new Map();
  for (const l of await page.evaluate(() => [...document.querySelectorAll('a[href*="/fichaequipo/"]')].map((a) => ({ h: a.href, t: a.innerText.trim().replace(/\s+/g, " ") })))) {
    const m = l.h.match(/fichaequipo\/(\d+)/);
    if (m && !vistos.get(m[1])) vistos.set(m[1], l.t);
  }
  for (const m of html.matchAll(/fichaequipo\/(\d+)/g)) if (!vistos.has(m[1])) vistos.set(m[1], "");
  for (const m of html.matchAll(/codigo_equipo\\?"\s*:\s*\\?"?(\d+)/g)) if (!vistos.has(m[1])) vistos.set(m[1], "");
  console.log(`Ficha del club: ${vistos.size} equipos`);

  const encontrados = [];
  const nuevosGrupos = new Map();
  let primero = true;
  for (const [cod, nombre] of vistos) {
    try {
      await page.goto(`${BASE}/fichaequipo/${cod}?temporada=${TEMP}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => /JUGADORES \(\d+\)|grupo=/.test(document.body.innerText + document.body.innerHTML.slice(0, 400000)), null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
      if (primero) { await vuelca("equipo-ejemplo"); primero = false; }
      const h = await page.content();
      const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((x) => /grupo=\d/.test(x)));
      const titulo = await page.evaluate(() => (document.querySelector("h1,h2")?.innerText || "").trim());
      const gs = new Map();
      for (const x of hrefs) {
        const u = new URL(x);
        const c = u.searchParams.get("competicion"), g = u.searchParams.get("grupo");
        if (c && g) gs.set(`${c}-${g}`, { competicion: c, grupo: g, tipojuego: u.searchParams.get("tipojuego") });
      }
      for (const m of h.matchAll(/competicion=(\d+)(?:&|&amp;|\\u0026)grupo=(\d+)/g)) if (!gs.has(`${m[1]}-${m[2]}`)) gs.set(`${m[1]}-${m[2]}`, { competicion: m[1], grupo: m[2] });
      for (const m of h.matchAll(/codigo_competicion\\?"\s*:\s*\\?"?(\d+)[\s\S]{0,400}?codigo_grupo\\?"\s*:\s*\\?"?(\d+)/g)) if (!gs.has(`${m[1]}-${m[2]}`)) gs.set(`${m[1]}-${m[2]}`, { competicion: m[1], grupo: m[2] });
      const nom = nombre || titulo;
      console.log(`  Equipo ${cod} ${nom}: ${gs.size} grupo(s)`);
      encontrados.push({ cod, nombre: nom, grupos: [...gs.keys()] });
      for (const [k, g] of gs) if (!nuevosGrupos.has(k)) nuevosGrupos.set(k, { ...g, equipo: nom });
    } catch (e) { console.error(`  Equipo ${cod}: ${e.message.split("\n")[0]}`); }
  }
  return { encontrados, nuevosGrupos };
}

if (!RAPIDA || !grupos.length) {
  try {
    const { encontrados, nuevosGrupos } = await descubrir();
    for (const g of GRUPOS_FIJOS) if (!nuevosGrupos.has(clave(g))) nuevosGrupos.set(clave(g), { ...g });
    // Nombres de competiciones y grupos (y su tipo de juego) desde la API de la RFFM
    const comps = {};
    try {
      const tipos = await api("/api/game-types");
      for (const t of Array.isArray(tipos) ? tipos : []) {
        const tj = String(t.codigo ?? t.id ?? "");
        if (!tj) continue;
        try { for (const c of await api(`/api/competitions?temporada=${TEMP}&tipojuego=${tj}`)) comps[String(c.codigo)] = { nombre: c.nombre, tipojuego: tj }; } catch {}
      }
    } catch (e) { console.error("Tipos de juego:", e.message); }
    console.log(`Competiciones conocidas: ${Object.keys(comps).length}`);
    const lista = [];
    for (const g of nuevosGrupos.values()) {
      const c = comps[g.competicion] || {};
      let nombreGrupo = "";
      try { nombreGrupo = ((await api(`/api/groups?competicion=${g.competicion}`)).find((x) => String(x.codigo) === g.grupo) || {}).nombre || ""; } catch {}
      lista.push({ ...g, tipojuego: g.tipojuego || c.tipojuego || "1", comp: c.nombre || "", nombreGrupo });
    }
    if (lista.length > GRUPOS_FIJOS.length) {
      grupos = lista;
      equipos = encontrados;
    } else console.error(`Solo ${lista.length} grupo(s) encontrados; mantengo la lista anterior (${grupos.length}).`);
  } catch (e) { console.error("Fallo buscando los equipos:", e.message.split("\n")[0]); }
  if (!grupos.length) grupos = GRUPOS_FIJOS.map((g) => ({ ...g, comp: "", nombreGrupo: "" }));
  fs.writeFileSync(`${DEBUG}/api-urls.txt`, [...new Set(APIS.map((a) => a.url))].join("\n"));
}
console.log(`Grupos a leer: ${grupos.length}`);

// ---------- 2. CALENDARIO DE CADA GRUPO ----------
async function leerCalendario() {
  const jornadas = [];
  const items = await page.evaluate(() => {
    const all = [...document.querySelectorAll("body *")];
    const txt = (el) => (el.innerText || "").trim();
    const nActas = (el) => (txt(el).match(/VER ACTA/gi) || []).length;
    const out = [];
    for (const el of all) {
      if (el.children.length === 0 && /^JORNADA\s+\d+$/i.test(txt(el))) {
        let box = el;
        while (box.parentElement && !/\(\d\d-\d\d-\d{4}\)/.test(txt(box)) && nActas(box.parentElement) === 0) box = box.parentElement;
        const f = txt(box).match(/\((\d\d)-(\d\d)-(\d{4})\)/);
        out.push({ el, tipo: "j", j: +txt(el).match(/\d+/)[0], fecha: f ? `${f[3]}-${f[2]}-${f[1]}` : null });
      }
    }
    for (const el of all) {
      if (!/^VER ACTA$/i.test(txt(el))) continue;
      if ([...el.children].some((c) => /VER ACTA/i.test(txt(c)))) continue;
      let row = el;
      while (row.parentElement && nActas(row.parentElement) === 1) row = row.parentElement;
      const a = el.closest("a") || el.querySelector("a");
      out.push({ el: row, tipo: "m", lineas: txt(row).split("\n").map((s) => s.trim()).filter(Boolean), acta: a ? a.href : null });
    }
    out.sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const seen = new Set();
    return out.filter((o) => (seen.has(o.el) ? false : seen.add(o.el))).map(({ el, ...rest }) => rest);
  });
  let cur = null;
  for (const it of items) {
    if (it.tipo === "j") { cur = { j: it.j, fecha: it.fecha, partidos: [] }; jornadas.push(cur); continue; }
    if (!cur) continue;
    const L = it.lineas.filter((s) => !/^VER ACTA$/i.test(s));
    const iScore = L.findIndex((s) => /^(\d+\s*-\s*\d+|-)$/.test(s));
    if (iScore < 0) continue;
    const local = L.slice(0, iScore).join(" "), visit = L.slice(iScore + 1).join(" ");
    if (/No asignado/i.test(local + visit)) continue;
    const g = L[iScore].match(/(\d+)\s*-\s*(\d+)/);
    cur.partidos.push({ local, visit, g: g ? [+g[1], +g[2]] : null, acta: it.acta });
  }
  return jornadas;
}

const esBarajas = (t) => /^C\.?\s*D\.?\s+BARAJAS\b/i.test((t || "").trim());
const encontrados = []; // partidos del Barajas en la ventana
const leidos = new Set();
for (const g of grupos) {
  const q = `temporada=${TEMP}&tipojuego=${g.tipojuego}&competicion=${g.competicion}&grupo=${g.grupo}`;
  try {
    await page.goto(`${BASE}/competicion/calendario?${q}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => document.body.innerText.includes("VER ACTA"), null, { timeout: 45000 });
    await page.waitForTimeout(1200);
    const js = await leerCalendario();
    let n = 0;
    for (const j of js) {
      if (!j.fecha || j.fecha < DESDE || j.fecha > HASTA) continue;
      for (const p of j.partidos) {
        if (!esBarajas(p.local) && !esBarajas(p.visit)) continue;
        encontrados.push({ ...p, gr: g, j: j.j, fJornada: j.fecha });
        n++;
      }
    }
    leidos.add(clave(g));
    console.log(`${g.comp || q} ${g.nombreGrupo}: ${js.length} jornadas, ${n} partido(s) nuestros en la ventana`);
    if (!js.length) await vuelca(`calendario-vacio-${g.grupo}`);
  } catch (e) {
    console.error(`Calendario ${g.comp || q}: ${e.message.split("\n")[0]}`);
    await vuelca(`calendario-error-${g.grupo}`);
  }
}

// ---------- 3. ACTAS: día, hora y campo ----------
async function leerActa(url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes("TERRENO DE JUEGO"), null, { timeout: 40000 });
  await page.waitForTimeout(600);
  const t = await page.evaluate(() => document.body.innerText);
  const L = t.split("\n").map((x) => x.trim()).filter(Boolean);
  const fh = t.match(/(\d\d)-(\d\d)-(\d{4})\s*\/\s*(\d{1,2}:\d\d)/);
  const iT = L.indexOf("TERRENO DE JUEGO");
  const campo = iT >= 0 && L[iT + 1] && !/^Patrocinador/i.test(L[iT + 1]) ? L[iT + 1] : null;
  let casa = null;
  for (const s of await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => x.textContent))) {
    try { const ev = JSON.parse(s); if (ev["@type"] === "SportsEvent" && ev.homeTeam?.name) casa = ev.homeTeam.name.trim(); } catch {}
  }
  return { fecha: fh ? `${fh[3]}-${fh[2]}-${fh[1]}` : null, hora: fh && fh[4] !== "00:00" ? fh[4] : null, campo, casa };
}

// Se abren primero los partidos más cercanos. Se relee un acta si no se tiene, si ya debería
// tener horario oficial y no lo tenía, o si el partido es en los próximos 8 días y hace más de 3 h.
encontrados.sort((a, b) => a.fJornada.localeCompare(b.fJornada));
let nActas = 0;
for (const p of encontrados) {
  if (!p.acta) continue;
  const c = actas[p.acta];
  const cerca = p.fJornada <= sumaDias(HOY, 8);
  const viejo = !c || (!c.of && yaOficial(p.fJornada)) || (cerca && Date.now() - (c.t || 0) > 3 * 3600e3) || !c.hora;
  if (!viejo) continue;
  if (minutos() > LIMITE) { console.error("Se acaba el tiempo; quedan actas sin leer"); break; }
  try {
    const a = await leerActa(p.acta);
    const cambios = [...((c && c.cambios) || [])];
    if (c && c.of && c.hora && a.hora && (c.hora !== a.hora || c.fecha !== a.fecha)) cambios.push({ antes: `${c.fecha} ${c.hora}`, ahora: `${a.fecha} ${a.hora}` });
    if (c && c.of && c.campo && a.campo && c.campo !== a.campo) cambios.push({ antes: c.campo, ahora: a.campo });
    actas[p.acta] = { ...a, of: yaOficial(a.fecha || p.fJornada), t: Date.now(), ...(cambios.length ? { cambios } : {}) };
    nActas++;
  } catch (e) {
    console.error(`Acta ${p.acta}: ${e.message.split("\n")[0]}`);
    if (!nActas && !fs.existsSync(`${DEBUG}/acta-error.txt`)) await vuelca("acta-error");
  }
}
console.log(`Actas leídas: ${nActas}`);

// ---------- 4. GUARDAR ----------
const CATS = [
  ["QUERUB", "Querubín"], ["PREBENJAM", "Prebenjamín"], ["BENJAM", "Benjamín"], ["ALEV", "Alevín"], ["INFANT", "Infantil"],
  ["CADET", "Cadete"], ["JUVENIL", "Juvenil"], ["VETERAN", "Veteranos"], ["AFICIONAD", "Aficionado"], ["SENIOR", "Senior"], ["SÉNIOR", "Senior"],
];
const categoria = (comp) => { const C = (comp || "").toUpperCase(); const x = CATS.find(([k]) => C.includes(k)); return x ? x[1] : ""; };
const partidos = encontrados.map((p) => {
  const a = actas[p.acta] || {};
  const local = a.casa ? esBarajas(a.casa) : esBarajas(p.local);
  const nuestro = esBarajas(p.local) ? p.local : p.visit;
  return {
    id: p.acta || `${clave(p.gr)}-${p.j}`,
    gk: clave(p.gr),
    cat: categoria(p.gr.comp),
    fem: /FEMENIN/i.test(p.gr.comp || ""),
    f7: String(p.gr.tipojuego) === "2" || /F-?7|FUTBOL 7|FÚTBOL 7/i.test(p.gr.comp || ""),
    comp: p.gr.comp || "",
    grupo: p.gr.nombreGrupo || "",
    equipo: nuestro.trim(),
    rival: (esBarajas(p.local) ? p.visit : p.local).trim(),
    local,
    jornada: p.j,
    fJornada: p.fJornada,
    fecha: a.fecha || null,
    hora: a.hora || null,
    campo: a.campo || null,
    oficial: !!a.of,
    jugado: !!p.g,
    ...(p.g ? { res: p.g } : {}),
    ...(a.cambios ? { cambios: a.cambios } : {}),
  };
});
// Los grupos que esta vez no se han podido leer conservan sus partidos anteriores
for (const x of previo.partidos || []) {
  if (leidos.has(x.gk)) continue;
  if ((x.fecha || x.fJornada) >= DESDE && !partidos.some((p) => p.id === x.id)) partidos.push(x);
}
// Limpiar la caché de actas viejas
for (const k of Object.keys(actas)) if ((actas[k].fecha || "9999") < sumaDias(HOY, -14)) delete actas[k];

const ok = leidos.size > 0 && leidos.size >= Math.ceil(grupos.length / 2);
if (ok) {
  fs.writeFileSync("data.json", JSON.stringify({
    actualizado: new Date().toISOString(),
    lunes: LUNES,
    equipos, grupos,
    leidos: leidos.size,
    partidos: partidos.sort((a, b) => ((a.fecha || a.fJornada) + (a.hora || "99")).localeCompare((b.fecha || b.fJornada) + (b.hora || "99"))),
    actas,
  }, null, 1));
  console.log(`data.json: ${partidos.length} partidos (${partidos.filter((p) => p.local).length} en casa) · ${leidos.size}/${grupos.length} grupos leídos`);
} else {
  console.error(`Solo se han leído ${leidos.size} de ${grupos.length} grupos; no toco data.json.`);
}
fs.writeFileSync(`${DEBUG}/api.json`, JSON.stringify(APIS.slice(0, 40), null, 1).slice(0, 1_500_000));
await browser.close();
if (!ok) process.exit(1);
