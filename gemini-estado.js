// ============================================================
// Interruptor de Gemini FLOTA — estado en memoria del isolate
// Cuando Gemini responde 429 (cuota) VARIAS veces seguidas se pausa por un rato: las demás fotos de la ráfaga no gastan
// tiempo en una llamada que va a fallar y pasan directo al respaldo. Un 429 aislado NO pausa: cuesta ~0.2 s, mientras que
// saltarse Gemini cuesta 8-10 s por foto (Sonnet), y todas las fotos de una ráfaga llegan a Gemini casi a la vez.
// Es por isolate: no se comparte entre isolates ni sobrevive a un reinicio (basta, es solo un atajo).
// ============================================================

const SEGUIDOS_PARA_PAUSAR = 2;   // 429 seguidos, sin un éxito entre medias, que activan la pausa
const PAUSA_429_MS = 10000;       // pasada la pausa la siguiente foto vuelve a probar a Gemini (si da 429 otra vez, pausa de nuevo)

let pausadoHasta = 0;   // epoch ms hasta el que Gemini está en pausa (0 = disponible)
let seguidos429 = 0;    // 429 seguidos desde el último éxito

export function geminiDisponible(ahora = Date.now()) {
  return ahora >= pausadoHasta;
}

// Una pausa nunca se acorta: si ya había una más larga, se conserva
export function pausarGemini(ms = 60000, ahora = Date.now()) {
  pausadoHasta = Math.max(pausadoHasta, ahora + ms);
}

// Gemini respondió 429: pausa solo cuando se repite sin un éxito entre medias
export function gemini429(ahora = Date.now()) {
  seguidos429++;
  if (seguidos429 >= SEGUIDOS_PARA_PAUSAR) pausarGemini(PAUSA_429_MS, ahora);
}

// Gemini respondió bien (HTTP 200): la cuenta de 429 seguidos vuelve a cero
export function geminiBien() {
  seguidos429 = 0;
}

// Solo para pruebas
export function reiniciarGemini() {
  pausadoHasta = 0;
  seguidos429 = 0;
}
