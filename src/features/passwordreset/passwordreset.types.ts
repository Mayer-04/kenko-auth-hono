import type { DocumentType } from '../user/user.types.js';

/**
 * Dominio del caso de uso `passwordreset` (solicitud y restablecimiento).
 *
 * El token solo existe en claro en memoria y en el evento `PasswordResetRequested`
 * (decision D1: viaja en claro con mitigaciones). En la base de datos se guarda
 * SOLO su hash SHA-256.
 */

/** Entrada de `forgot` ya normalizada. */
export type ForgotInput = {
  documentType: DocumentType;
  documentNumber: string;
};

/** Entrada de `reset`: el token llega en el BODY, nunca en la URL. */
export type ResetInput = {
  token: string;
  password: string;
};

/** Resultado de ambos casos de uso. Solo IDs, sin PII ni token. */
export type PasswordResetResult = {
  correlationId: string;
};

/**
 * Contenido de `Detail` del evento `PasswordResetRequested` v1.1.
 *
 * Auth construye `resetUrl` con `PORTAL_BASE_URL` (enlace con fragmento
 * `#token=` para que el token no viaje en query ni en `Referer`) y ya NO
 * envia `resetToken` suelto en `data`: el token en claro solo existe dentro
 * del fragmento de `resetUrl`. En la base de datos se sigue guardando SOLO
 * su hash SHA-256. Tratar todo el payload como secreto.
 */
export type PasswordResetRequestedDetail = {
  metadata: {
    eventId: string;
    eventVersion: '1';
    occurredAt: string;
    correlationId: string;
  };
  data: {
    userId: string;
    email: string;
    firstName: string;
    resetUrl: string;
    expiresAt: string;
  };
};
