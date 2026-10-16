/**
 * Cotas de transporte de la API.
 *
 * `REQUEST_BODY_LIMIT_BYTES` topea el cuerpo JSON (proteccion contra abuso).
 * `PORT_MIN/MAX` son el rango TCP valido para `PORT`.
 */
export const REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
export const PORT_MIN = 1;
export const PORT_MAX = 65_535;
