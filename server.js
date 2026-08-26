import express from "express";
import { chromium } from "playwright";
import fs from "node:fs/promises";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = Number(process.env.TRACK_TIMEOUT_MS || 30000);
const SERVIENTREGA_TIMEOUT_MS = Number(process.env.SERVIENTREGA_TIMEOUT_MS || 60000);
const CACHE_TTL_MS = Number(process.env.TRACK_CACHE_TTL_MS || 300000);

const cache = new Map();
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function splitLines(rawText) {
  return rawText
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function valueAfter(lines, labelRegex) {
  const idx = lines.findIndex((l) => labelRegex.test(l));
  if (idx >= 0 && idx + 1 < lines.length) return lines[idx + 1];
  return null;
}

function matchLine(lines, regex) {
  const line = lines.find((l) => regex.test(l));
  if (!line) return null;
  const match = line.match(regex);
  return match ? match[1]?.trim() || null : null;
}

function parseInterrapidisimoRaw(rawText, { includeLines } = {}) {
  const lines = splitLines(rawText);
  const guia =
    matchLine(lines, /Gu[ií]a\s*-\s*(\d+)/i) ||
    matchLine(lines, /Gu[ií]a\s*(\d+)/i) ||
    null;
  const origen = valueAfter(lines, /^Origen$/i);
  const destino = valueAfter(lines, /^Destino$/i);
  const estadoActual = valueAfter(lines, /^Estado actual de tu env[ií]o$/i);
  const fechaEstimadaEntrega = matchLine(lines, /Fecha estimada de entrega:\s*(.+)/i);

  const pasos = [];
  for (const line of lines) {
    const fecha = line.match(/Fecha:\s*(.+)/i);
    const ciudad = line.match(/Ciudad:\s*(.+)/i);
    if (fecha || ciudad) {
      pasos.push({
        fecha: fecha ? fecha[1].trim() : null,
        ciudad: ciudad ? ciudad[1].trim() : null
      });
    }
  }

  const parsed = {
    guia,
    origen,
    destino,
    estado_actual: estadoActual,
    fecha_estimada_entrega: fechaEstimadaEntrega,
    pasos
  };
  if (includeLines) parsed.lineas = lines;
  return parsed;
}

function parseCoordinadoraRaw(rawText, { includeLines } = {}) {
  const lines = splitLines(rawText);
  const compact = rawText.replace(/\s+/g, " ").trim();
  let normalized = compact
    .replace(/Historial(\d{4}\/\d{2}\/\d{2})/g, "Historial $1")
    .replace(/(\d{4}\/\d{2}\/\d{2})(\d{2}:\d{2}\s*[AP]M)/g, "$1 $2");

  const detailMatch = normalized.match(
    /Detalle de Rastreo(.+?)(Historial|Rastrear otra Gu[ií]a|Suite Log[íi]stica)/i
  );
  const detailSegment = detailMatch ? detailMatch[1] : normalized;

  const numeroGuia =
    (detailSegment.match(/N[uú]mero de gu[ií]a:\s*([0-9]+)/i) || [])[1] || null;
  const origen =
    (detailSegment.match(/Origen:\s*(.+?)\s*Estado de la gu[ií]a:/i) || [])[1] ||
    null;
  const estadoGuia =
    (detailSegment.match(/Estado de la gu[ií]a:\s*(.+?)\s*Destino:/i) || [])[1] ||
    null;
  const destino =
    (detailSegment.match(
      /Destino:\s*(.+?)(Visualizar Gu[ií]a Digital|Conocer Tiempos de Entrega|$)/i
    ) || [])[1] || null;

  const eventos = [];
  const eventRegex =
    /(\d{4}\/\d{2}\/\d{2})\s*(\d{2}:\d{2}\s*[AP]M)\s*([A-Za-zÁÉÍÓÚÑñ\s]+?)(?=\d{4}\/\d{2}\/\d{2}\s*\d{2}:\d{2}\s*[AP]M|$)/g;
  let m;
  while ((m = eventRegex.exec(detailSegment)) !== null) {
    eventos.push({
      fecha: m[1],
      hora: m[2],
      estado: m[3].trim()
    });
  }

  let historial = [];
  const histMatch = normalized.match(
    /Historial\s*(.+?)(Suite Log[íi]stica|Rastrear otra Gu[ií]a|$)/i
  );
  if (histMatch) {
    const histSegment = histMatch[1];
    let mh;
    while ((mh = eventRegex.exec(histSegment)) !== null) {
      historial.push({
        fecha: mh[1],
        hora: mh[2],
        detalle: mh[3].trim()
      });
    }
  }

  const parsed = {
    numero_guia: numeroGuia,
    origen,
    destino,
    estado_guia: estadoGuia,
    eventos,
    historial
  };
  if (includeLines) parsed.lineas = lines;
  return parsed;
}

function parseServientregaRaw(rawText, { includeLines } = {}) {
  const lines = splitLines(rawText);
  const compact = rawText.replace(/\s+/g, " ").trim();

  const guia =
    (lines[lines.indexOf("Número de la guía") + 1] || "").match(/\d+/)?.[0] || null;

  const origen = valueAfter(lines, /^Ciudad de Recogida$/i);
  const destino = valueAfter(lines, /^Ciudad de Destino$/i);
  const regimen = valueAfter(lines, /^Régimen$/i);
  const cantidad = valueAfter(lines, /^Cantidad Envíos$/i);

  const estadoMatch =
    compact.match(/(ENTREGADO A REMITENTE|ENTREGADO|EN RUTA|RECIBIDO)/i) || null;
  const estado = estadoMatch ? estadoMatch[1] : null;

  const verificacion_requerida =
    /c[oó]digo de verificaci[oó]n|Queremos asegurarnos|Enviar c[oó]digo/i.test(compact);

  // Parse historial
  let historial = [];
  const histMatch = compact.match(/HISTORIAL\s*(.+?)(Aceptar|Cerrar|$)/i);
  if (histMatch) {
    const histSegment = histMatch[1];
    const rx = /(\d{2}\/\d{2}\/\d{4})\s*([^0-9]+?)\s*(\d{2}:\d{2})/g;
    let m;
    while ((m = rx.exec(histSegment)) !== null) {
      historial.push({
        fecha: m[1],
        hora: m[3],
        detalle: m[2].trim()
      });
    }
  }

  const parsed = {
    guia,
    origen,
    destino,
    regimen,
    cantidad_envios: cantidad || null,
    estado,
    verificacion_requerida,
    historial
  };
  if (includeLines) parsed.lineas = lines;
  return parsed;
}

function requireGuiaAndCarrier(req, res, next) {
  const guia = String(req.body?.guia || "").trim();
  const transportadora = String(req.body?.transportadora || "").trim().toLowerCase();
  if (!guia) {
    return res.status(400).json({ ok: false, error: "Falta el campo 'guia'" });
  }
  if (!transportadora) {
    return res
      .status(400)
      .json({ ok: false, error: "Falta el campo 'transportadora'" });
  }
  if (!["coordinadora", "interrapidisimo", "servientrega", "envia"].includes(transportadora)) {
    return res.status(400).json({
      ok: false,
      error: "Transportadora inválida. Usa 'coordinadora', 'interrapidisimo', 'servientrega' o 'envia'."
    });
  }
  req.guia = guia;
  req.transportadora = transportadora;
  next();
}

async function fillGuiaInAnyFrame(page, guia, labelRegex) {
  // Try main frame first
  const tryFill = async (frame) => {
    const labeled = frame.getByLabel(labelRegex).first();
    if (await labeled.count()) {
      try {
        await labeled.fill(guia, { timeout: 3000 });
        return true;
      } catch {
        // continue to other strategies
      }
    }

    const placeholder = frame
      .locator("input[placeholder], input[aria-label]")
      .filter({ hasText: "" })
      .first();
    if (await placeholder.count()) {
      try {
        await placeholder.fill(guia, { timeout: 3000 });
        return true;
      } catch {
        // continue to other strategies
      }
    }

    const anyText = frame.locator("input[type='text'], input:not([type])").first();
    if (await anyText.count()) {
      try {
        await anyText.fill(guia, { timeout: 3000 });
        return true;
      } catch {
        // continue to other strategies
      }
    }

    // Shadow DOM / custom elements fallback
    const deepFilled = await frame.evaluate(
      ({ guiaValue, labelPattern }) => {
        const labelRe = new RegExp(labelPattern, "i");
        const seen = new Set();
        const queue = [document.documentElement];

        const matchInput = (el) => {
          if (!(el instanceof HTMLInputElement)) return false;
          if (el.type && !["text", "search", "tel", "number", "email"].includes(el.type)) {
            return false;
          }
          const attrs =
            (el.getAttribute("aria-label") || "") +
            " " +
            (el.getAttribute("placeholder") || "") +
            " " +
            (el.name || "") +
            " " +
            (el.id || "");
          return labelRe.test(attrs) || labelRe.test(el.closest("label")?.innerText || "");
        };

        while (queue.length) {
          const node = queue.shift();
          if (!node || seen.has(node)) continue;
          seen.add(node);

          if (node instanceof HTMLInputElement && matchInput(node)) {
            node.focus();
            node.value = guiaValue;
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }

          if (node.shadowRoot) queue.push(node.shadowRoot);
          if (node.children) queue.push(...node.children);
        }

        // As a last resort, try the first visible input
        const inputs = Array.from(document.querySelectorAll("input"));
        const visible = inputs.find(
          (i) => i.offsetParent !== null && (!i.type || ["text", "search"].includes(i.type))
        );
        if (visible) {
          visible.focus();
          visible.value = guiaValue;
          visible.dispatchEvent(new Event("input", { bubbles: true }));
          visible.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }

        return false;
      },
      { guiaValue: guia, labelPattern: labelRegex.source }
    );
    if (deepFilled) return true;

    return false;
  };

  if (await tryFill(page)) return true;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (await tryFill(frame)) return true;
  }

  return false;
}

async function clickSearchButton(page) {
  const button = page
    .getByRole("button", { name: /rastrear|buscar|consultar|seguir/i })
    .first();
  if (await button.count()) {
    await button.click();
    return true;
  }
  return false;
}

async function maybeDumpDebug(page, tag) {
  const ts = Date.now();
  const base = `/tmp/tracking-debug-${tag}-${ts}`;
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
  } catch {}
  try {
    const html = await page.content();
    await fs.writeFile(`${base}.html`, html, "utf8");
  } catch {}
  return { screenshot: `${base}.png`, html: `${base}.html` };
}

async function trackCoordinadora({ guia, startedAt, debug, includeLines }) {
  const browser = await getBrowser();
  let page;
  let context;
  try {
    context = await browser.newContext();
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    const url = `https://coordinadora.com/rastreo/rastreo-de-guia/detalle-de-rastreo-de-guia/?guia=${encodeURIComponent(
      guia
    )}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

    const resultContainer = page
      .locator("[class*='resultado'], [class*='tracking'], [class*='estado'], [id*='resultado']")
      .first();

    let rawText = "";
    try {
      await resultContainer.waitFor({ timeout: TIMEOUT_MS });
      rawText = (await resultContainer.innerText()).trim();
    } catch {
      rawText = (await page.textContent("body"))?.trim() || "";
    }

    const parsed = parseCoordinadoraRaw(rawText, { includeLines });

    return {
      ok: true,
      transportadora: "coordinadora",
      guia,
      parsed,
      raw: rawText,
      took_ms: Date.now() - startedAt
    };
  } catch (err) {
    const debugInfo = debug && page ? await maybeDumpDebug(page, "coordinadora") : null;
    throw new Error(
      `${err?.message || "Error en Coordinadora"}${debugInfo ? ` Debug: ${JSON.stringify(debugInfo)}` : ""}`
    );
  } finally {
    if (context) await context.close();
  }
}

async function trackInterrapidisimo({ guia, startedAt, debug, includeLines }) {
  const browser = await getBrowser();
  let page;
  let context;
  try {
    context = await browser.newContext();
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    await page.goto("https://interrapidisimo.com/sigue-tu-envio/", {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS
    });

    // Interrapidísimo usa un formulario con JS que abre una URL con la guía encriptada.
    // Capturamos window.open para obtener esa URL sin depender del botón.
    await page.evaluate(() => {
      window.__openedUrl = null;
      const originalOpen = window.open;
      window.open = (url, target, features) => {
        window.__openedUrl = url;
        return originalOpen ? originalOpen(url, target, features) : null;
      };
    });

    const inputSelector = "#inputGuide, #form-field-numeroguia, #txtDatoR, input.buscarGuiaInput";
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    await page.evaluate(
      ({ selector, value }) => {
        const el = document.querySelector(selector);
        if (!el) return;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { selector: inputSelector, value: guia }
    );

    const called = await page.evaluate(() => {
      if (typeof redirectGuide === "function") {
        redirectGuide();
        return true;
      }
      return false;
    });

    if (!called) {
      // Fallback: intenta click de botones conocidos
      const btnSelector = "#BtnGuide, #buscarGuia, #BtnR, button.buscarGuia";
      const btn = page.locator(btnSelector).first();
      if (await btn.count()) {
        await btn.click();
      } else {
        await page.keyboard.press("Enter");
      }
    }

    const openedUrl = await page.evaluate(() => window.__openedUrl);
    if (!openedUrl) {
      const filled = await fillGuiaInAnyFrame(page, guia, /gu[ií]a|env[ií]o|n[uú]mero/i);
      if (!filled) {
        const debugInfo = debug ? await maybeDumpDebug(page, "interrapidisimo") : null;
        throw new Error(
          `No se pudo generar URL de rastreo.${debugInfo ? ` Debug: ${JSON.stringify(debugInfo)}` : ""}`
        );
      }
    } else {
      await page.goto(openedUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    }

    const clicked = await clickSearchButton(page);
    if (!clicked) {
      await page.keyboard.press("Enter");
    }

    const resultContainer = page
      .locator("[class*='resultado'], [class*='tracking'], [class*='estado'], [id*='resultado']")
      .first();

    let rawText = "";
    try {
      await resultContainer.waitFor({ timeout: TIMEOUT_MS });
      rawText = (await resultContainer.innerText()).trim();
    } catch {
      rawText = (await page.textContent("body"))?.trim() || "";
    }

    const parsed = parseInterrapidisimoRaw(rawText, { includeLines });

    return {
      ok: true,
      transportadora: "interrapidisimo",
      guia,
      parsed,
      raw: rawText,
      took_ms: Date.now() - startedAt
    };
  } catch (err) {
    const debugInfo = debug && page ? await maybeDumpDebug(page, "interrapidisimo") : null;
    throw new Error(
      `${err?.message || "Error en Interrapidisimo"}${debugInfo ? ` Debug: ${JSON.stringify(debugInfo)}` : ""}`
    );
  } finally {
    if (context) await context.close();
  }
}

async function trackServientrega({ guia, startedAt, debug, includeLines }) {
  const browser = await getBrowser();
  let page;
  let context;
  try {
    context = await browser.newContext();
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(SERVIENTREGA_TIMEOUT_MS);
    // El formulario real está embebido en un iframe en el portal.
    const servientregaUrl = "https://mobile.servientrega.com/WebSitePortal/RastreoEnvio.html";
    try {
      await page.goto(servientregaUrl, {
        waitUntil: "domcontentloaded",
        timeout: SERVIENTREGA_TIMEOUT_MS
      });
    } catch (e) {
      // Retry once con networkidle para conexiones lentas
      await page.goto(servientregaUrl, {
        waitUntil: "networkidle",
        timeout: SERVIENTREGA_TIMEOUT_MS
      });
    }

    const filled = await fillGuiaInAnyFrame(page, guia, /gu[ií]a|env[ií]o|n[uú]mero|documento/i);
    if (!filled) {
      const debugInfo = debug ? await maybeDumpDebug(page, "servientrega") : null;
      throw new Error(
        `No se encontró input de guía en Servientrega.${debugInfo ? ` Debug: ${JSON.stringify(debugInfo)}` : ""}`
      );
    }

    const clicked = await clickSearchButton(page);
    if (!clicked) {
      await page.keyboard.press("Enter");
    }

    const resultContainer = page
      .locator("[class*='resultado'], [class*='tracking'], [class*='estado'], [id*='resultado']")
      .first();

    let rawText = "";
    try {
      await resultContainer.waitFor({ timeout: TIMEOUT_MS });
      rawText = (await resultContainer.innerText()).trim();
    } catch {
      rawText = (await page.textContent("body"))?.trim() || "";
    }

    const parsed = parseServientregaRaw(rawText, { includeLines });

    return {
      ok: true,
      transportadora: "servientrega",
      guia,
      parsed,
      raw: rawText,
      took_ms: Date.now() - startedAt
    };
  } catch (err) {
    const debugInfo = debug && page ? await maybeDumpDebug(page, "servientrega") : null;
    throw new Error(
      `${err?.message || "Error en Servientrega"}${debugInfo ? ` Debug: ${JSON.stringify(debugInfo)}` : ""}`
    );
  } finally {
    if (context) await context.close();
  }
}

async function trackEnvia({ guia, startedAt, debug, includeLines }) {
  const browser = await getBrowser();
  let page;
  let context;

  try {
    context = await browser.newContext();

    await context.route("**/*", (route) => {
      const type = route.request().resourceType();

      if (["image", "media", "font"].includes(type)) {
        return route.abort();
      }

      return route.continue();
    });

    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    await page.goto("https://envia.co/", {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS
    });

    const formulario = page.locator("#cotizador_rastrea_num");
    const campoGuia = formulario.locator("input.input-rastreo");
    const botonRastrear = formulario.locator("button.btn_primary");

    await campoGuia.waitFor({
      state: "visible",
      timeout: TIMEOUT_MS
    });

    // La guía se maneja como texto para conservar el cero inicial.
    await campoGuia.fill(String(guia));

    await botonRastrear.click();

    // Espera a que Envía cargue la pantalla con el resultado.
    await page.waitForTimeout(5000);

    await page
      .waitForFunction(
        (numeroGuia) =>
          document.body.innerText.includes(numeroGuia) ||
          !window.location.href.endsWith("envia.co/"),
        guia,
        { timeout: TIMEOUT_MS }
      )
      .catch(() => null);

    const rawText =
      (await page.locator("body").innerText().catch(() => ""))?.trim() || "";

    const lineas = splitLines(rawText);

    const parsed = {
      guia,
      estado_actual: null,
      origen: null,
      destino: null
    };

    if (includeLines) {
      parsed.lineas = lineas;
    }

    return {
      ok: true,
      transportadora: "envia",
      guia,
      parsed,
      raw: rawText,
      took_ms: Date.now() - startedAt
    };
  } catch (err) {
    const debugInfo =
      debug && page ? await maybeDumpDebug(page, "envia") : null;

    throw new Error(
      `${err?.message || "Error en Envía"}${
        debugInfo ? ` Debug: ${JSON.stringify(debugInfo)}` : ""
      }`
    );
  } finally {
    if (context) {
      await context.close();
    }
  }
}

app.post("/tracking", requireGuiaAndCarrier, async (req, res) => {
  const guia = req.guia;
  const transportadora = req.transportadora;
  const debug = Boolean(req.body?.debug);
  const includeRaw = Boolean(req.body?.raw);
  const includeLines = Boolean(req.body?.lines);
  const startedAt = Date.now();
  const includeLinesFinal = includeLines || debug || includeRaw;
  const cacheKey = `${transportadora}:${guia}`;
  const canUseCache = !debug && !includeRaw && !includeLines;

  if (canUseCache) {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
  }

  try {
    let result;

if (transportadora === "coordinadora") {
  result = await trackCoordinadora({
    guia,
    startedAt,
    debug,
    includeLines: includeLinesFinal
  });
} else if (transportadora === "interrapidisimo") {
  result = await trackInterrapidisimo({
    guia,
    startedAt,
    debug,
    includeLines: includeLinesFinal
  });
} else if (transportadora === "servientrega") {
  result = await trackServientrega({
    guia,
    startedAt,
    debug,
    includeLines: includeLinesFinal
  });
} else if (transportadora === "envia") {
  result = await trackEnvia({
    guia,
    startedAt,
    debug,
    includeLines: includeLinesFinal
  });
}
    if (!includeRaw && !debug) {
      delete result.raw;
    }
    if (!includeLines && !debug) {
      // If parsed includes lines, strip them unless requested
      if (result.parsed?.lineas) delete result.parsed.lineas;
    }
    if (canUseCache) {
      setCache(cacheKey, result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Error desconocido",
      guia,
      transportadora
    });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
});
