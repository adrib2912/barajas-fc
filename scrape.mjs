// Lee de la RFFM los partidos de todos los equipos del C.D. Barajas (todas las categorías)
// y guarda en data.json los del fin de semana actual y los dos siguientes, con día, hora y campo.
// Si algo sale raro, NO estropea data.json: conserva lo anterior y deja pistas en debug/.
import { chromium } from "playwright";
import fs from "node:fs";

const CLUB = "1019";             // código del C.D. Barajas en la RFFM (codigo_club en la ficha de un equipo)
const TEMP = "22";               // temporada 2026-2027 en la RFFM
const EQUIPO_F7 = "24025221";    // femenino senior F7 (código de equipo conocido)
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
const HASTA = sumaDias(LUNES, 41);   // este fin de semana y los cinco siguientes
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

// La RFFM mete los datos de cada página dentro del HTML (__NEXT_DATA__). Leerlos así es más rápido que
// esperar a que se dibuje la página. A veces vienen vacíos: se reintenta.
async function datosPagina(ruta, campo, intentos = 3) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await page.request.get(BASE + ruta, { timeout: 45000, headers: { accept: "text/html" } });
      const h = await r.text();
      const m = h.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) throw new Error(`sin datos (HTTP ${r.status()})`);
      const props = JSON.parse(m[1]).props?.pageProps || {};
      ultimo = props;
      const lleno = campo ? props[campo] : Object.keys(props).some((x) => !["global", "notices", "categories", "seasonName"].includes(x) && props[x]);
      if (lleno) return props;
      if (i === intentos) console.error(`${ruta}: '${campo || "datos"}' vacío tras ${intentos} intentos`);
    } catch (e) { if (i === intentos) console.error(`${ruta}: ${e.message.split("\n")[0]}`); }
    await page.waitForTimeout(2500 * i);
  }
  return ultimo || {};
}
// Recorre cualquier objeto buscando equipos (código + nombre) y parejas competición/grupo
function rastrea(obj, equipos, grupos, padre = "") {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { for (const x of obj) rastrea(x, equipos, grupos, padre); return; }
  const k = Object.keys(obj);
  const kEq = k.find((x) => /^(codigo_equipo|cod_equipo|codequipo|codigo)$/i.test(x));
  const kNom = k.find((x) => /^(nombre_equipo|nombre|equipo)$/i.test(x));
  if (kEq && kNom && /equipo/i.test(kEq + kNom + padre) && /^\d+$/.test(String(obj[kEq])) && typeof obj[kNom] === "string")
    equipos.set(String(obj[kEq]), obj[kNom].trim());
  const kC = k.find((x) => /^(codigo_competicion|cod_competicion|competicion)$/i.test(x));
  const kG = k.find((x) => /^(codigo_grupo|cod_grupo|grupo)$/i.test(x));
  if (kC && kG && /^\d+$/.test(String(obj[kC])) && /^\d+$/.test(String(obj[kG]))) {
    const tj = k.find((x) => /tipo_?juego/i.test(x));
    grupos.set(`${obj[kC]}-${obj[kG]}`, { competicion: String(obj[kC]), grupo: String(obj[kG]), tipojuego: tj ? String(obj[tj]) : null });
  }
  for (const x of k) rastrea(obj[x], equipos, grupos, x);
}

const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const fichas = (t) => norm(t).replace(/\bF ?7\b/g, "F7").replace(/\bF ?11\b/g, "F11").split(" ").filter(Boolean);
// Parecido entre dos nombres: proporción de palabras que coinciden (una abreviatura vale: ALEV = ALEVIN)
function parecido(a, b) {
  const A = fichas(a), B = fichas(b);
  if (!A.length || !B.length) return 0;
  const igual = (x, y) => x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y));
  const n = A.filter((x) => B.some((y) => igual(x, y))).length, m = B.filter((y) => A.some((x) => igual(x, y))).length;
  const p = Math.min(n / A.length, m / B.length);
  return n === A.length ? Math.max(p, 0.76) : p; // todas las palabras de la categoría están en la competición
}
let COMPS = []; // todas las competiciones de la temporada: {codigo, nombre, tipojuego}
async function cargarCompeticiones() {
  if (COMPS.length) return COMPS;
  await page.goto(`${BASE}/competicion/calendario`, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  let tipos = [];
  try { tipos = (await api("/api/game-types")).map((t) => String(t.codigo_tipo_juego ?? t.codigo)); } catch (e) { console.error("Tipos de juego:", e.message.split("\n")[0]); }
  if (!tipos.length) tipos = ["1", "2", "3"];
  for (const tj of tipos) {
    try { for (const c of await api(`/api/competitions?temporada=${TEMP}&tipojuego=${tj}`)) COMPS.push({ codigo: String(c.codigo), nombre: c.nombre, tipojuego: tj }); }
    catch (e) { console.error(`Competiciones tipo ${tj}:`, e.message.split("\n")[0]); }
  }
  console.log(`Competiciones de la temporada: ${COMPS.length}`);
  return COMPS;
}

const CAL = new Map(); // calendario (datos de la página) de cada grupo, como texto, para buscar equipos
async function calendarioTexto(c, g) {
  const k = `${c.codigo}-${g}`;
  if (!CAL.has(k)) {
    const p = await datosPagina(`/competicion/calendario?temporada=${TEMP}&tipojuego=${c.tipojuego}&competicion=${c.codigo}&grupo=${g}`, null, 2);
    let t = JSON.stringify({ ...p, global: undefined, notices: undefined, categories: undefined });
    // Si la página no trae los partidos en sus datos, se abre con el navegador y se lee el texto
    if (!/BARAJAS|equipo_local|"local"/i.test(t) && t.length < 20000) {
      try {
        await page.goto(`${BASE}/competicion/calendario?temporada=${TEMP}&tipojuego=${c.tipojuego}&competicion=${c.codigo}&grupo=${g}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForFunction(() => document.body.innerText.includes("VER ACTA"), null, { timeout: 30000 });
        t = JSON.stringify(await page.evaluate(() => document.body.innerText.split("\n").map((x) => x.trim())));
      } catch {}
    }
    if (CAL.size === 0) fs.writeFileSync(`${DEBUG}/calendario-datos.json`, t.slice(0, 300000));
    CAL.set(k, t);
  }
  return CAL.get(k);
}

async function descubrir() {
  const vistos = new Map();
  const nuevosGrupos = new Map();
  const props = await datosPagina(`/fichaclub/${CLUB}?temporada=${TEMP}`, "club");
  fs.writeFileSync(`${DEBUG}/club-datos.json`, JSON.stringify({ ...props, global: undefined, notices: undefined, categories: undefined }, null, 1).slice(0, 400000));
  rastrea(props.club, vistos, nuevosGrupos);
  vistos.delete(CLUB);
  console.log(`Ficha del club: ${vistos.size} equipos, ${nuevosGrupos.size} grupos`);
  if (!vistos.has(EQUIPO_F7)) vistos.set(EQUIPO_F7, "C.D. BARAJAS");
  await cargarCompeticiones();

  const encontrados = [];
  let primero = true;
  for (const [cod] of vistos) {
    const p = await datosPagina(`/fichaequipo/${cod}?temporada=${TEMP}`, "team", 2);
    const t = p.team || {};
    if (primero) { fs.writeFileSync(`${DEBUG}/equipo-datos.json`, JSON.stringify({ team: t }, null, 1).slice(0, 200000)); primero = false; }
    const nombre = (t.nombre_equipo || vistos.get(cod) || "").trim();
    const cat = t.categoria || "";
    if (!cat) { console.error(`  Equipo ${cod} ${nombre}: sin categoría`); continue; }
    // Competiciones con nombre parecido a la categoría del equipo ("ALEV.F-7" = "ALEVIN F-7", "F7" = "F-7")
    const cands = COMPS.map((c) => ({ c, p: parecido(cat, c.nombre) })).filter((x) => x.p >= 0.75)
      .sort((a, b) => b.p - a.p).slice(0, 4).map((x) => x.c);
    let hallado = null;
    for (const c of cands) {
      let gs = [];
      try { gs = await api(`/api/groups?competicion=${c.codigo}`); } catch {}
      for (const g of gs) {
        const txt = await calendarioTexto(c, String(g.codigo));
        if (txt.includes(`"${cod}"`) || txt.includes(JSON.stringify(nombre))) {
          hallado = { competicion: c.codigo, grupo: String(g.codigo), tipojuego: c.tipojuego, comp: c.nombre, nombreGrupo: g.nombre };
          break;
        }
      }
      if (hallado) break;
    }
    console.log(`  ${nombre} · ${cat}: ${hallado ? `${hallado.comp} ${hallado.nombreGrupo}` : `NO ENCONTRADO (${cands.length} competiciones candidatas)`}`);
    encontrados.push({ cod, nombre, cat, grupo: hallado ? clave(hallado) : null });
    if (hallado && !nuevosGrupos.has(clave(hallado))) nuevosGrupos.set(clave(hallado), { ...hallado, equipo: nombre });
  }
  return { encontrados, nuevosGrupos };
}

if (!RAPIDA || !grupos.length) {
  try {
    const { encontrados, nuevosGrupos } = await descubrir();
    for (const g of GRUPOS_FIJOS) if (!nuevosGrupos.has(clave(g))) nuevosGrupos.set(clave(g), { ...g });
    const comps = {};
    for (const c of await cargarCompeticiones()) comps[c.codigo] = { nombre: c.nombre, tipojuego: c.tipojuego };
    console.log(`Competiciones conocidas: ${Object.keys(comps).length}`);
    const lista = [];
    for (const g of nuevosGrupos.values()) {
      const c = comps[g.competicion] || {};
      let nombreGrupo = g.nombreGrupo || "";
      if (!nombreGrupo) try { nombreGrupo = ((await api(`/api/groups?competicion=${g.competicion}`)).find((x) => String(x.codigo) === g.grupo) || {}).nombre || ""; } catch {}
      lista.push({ ...g, tipojuego: g.tipojuego || c.tipojuego || "1", comp: g.comp || c.nombre || "", nombreGrupo });
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
  const u = new URL(url);
  const { game } = await datosPagina(u.pathname + u.search, "game", 3);
  if (!game) throw new Error("acta vacía");
  const f = String(game.fecha || "").match(/(\d\d)-(\d\d)-(\d{4})/);
  const hora = /^\d{1,2}:\d\d$/.test(game.hora || "") && game.hora !== "00:00" ? game.hora : null;
  return { fecha: f ? `${f[3]}-${f[2]}-${f[1]}` : null, hora, campo: (game.campo || "").trim() || null, casa: (game.equipo_local || "").trim() || null };
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
