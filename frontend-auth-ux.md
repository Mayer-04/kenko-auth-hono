# Frontend — Microservicio Authentication (Kenko EPS)

> Documento de especificación UX/frontend derivado del **código real** del backend
> (`src/features/register/`, `login/`, `passwordreset/`, `account/`,
> `src/shared/errors.ts`, `src/shared/http.ts`, `src/app.ts`, `README.md`, `docs/openapi.yaml`).
> Propósito: dárselo a un agente de IA frontend para que construya las vistas correctamente.
> El agente debe basarse en este documento + el código; si algo no está claro, debe marcarlo como **"suposición"** en vez de inventarlo.

Fuentes verificadas en código: esquemas Zod, rutas Hono, `AppError`, sobre `{ data } / { error }`, cookie `kenko_refresh`, límites por endpoint.

**Suposiciones** (tomadas del README/OpenAPI, no verificadas en constantes de servicio):
access token 15 min (`expiresIn: 900`), refresh 7 días, reset token TTL 30 min,
`resetUrl = <PORTAL_BASE_URL>/reset#token=<token>`, `emailVerified: false` al registrar,
el backend no expone lista de sesiones (solo "salir de todos los dispositivos").

---

## 1. Instrucciones obligatorias para el agente frontend

1. **No inventar endpoints, campos, códigos de error ni reglas.** Usar solo el contrato de la sección 3.
2. **Sobre de respuesta:** éxito `{ data: {...} }`; error `{ error: { code, message, correlationId, details? } }`.
   `details: [{ field?, message }]` existe **solo** en `VALIDATION_ERROR` → usarlo para pintar errores por campo.
   Usar `code` (estable) para lógica/i18n, nunca matchear por `message`.
3. **Seguridad:**
   - Nunca guardar el refresh en `localStorage`. Usar la cookie httpOnly `kenko_refresh` (el backend la fija/rota/limpia).
   - Nunca poner tokens en la URL al llamar a la API (`token` de reset va en el BODY).
   - No decodificar el JWT en la UI para mostrar datos; llamar `GET /auth/me`.
   - `Cache-Control: no-store` ya lo pone el backend; no cachear respuestas sensibles.
   - Nunca registrar ni mostrar en logs/consola: contraseñas, tokens, documento, email completo, teléfono, dirección.
   - Respetar la **anti-enumeración**: 409 de registro, 401 de login y 200 de forgot son genéricos a propósito.
     La UI no debe revelar si un correo/documento existe.
4. **Rate limiting:** ante `429`, leer `Retry-After` (y `RateLimit-Reset`) y mostrar cuenta regresiva. No reintentar en bucle.
5. **Accesibilidad (WCAG 2.2 AA) y móvil primero:** foco visible, contraste AA, objetivos táctiles ≥ 24px,
   etiquetas `<label>` reales, errores asociados con `aria-describedby`, no depender solo del color,
   lenguaje sencillo, apto para adultos mayores.
6. **Contexto Colombia:** tipos de documento `CC` (cédula de ciudadanía), `TI` (tarjeta de identidad),
   `CE` (cédula de extranjería), `PA` (pasaporte) con ayuda ("sin puntos ni guiones").
   Teléfono en formato internacional E.164 (ej. `+573001234567`). Incluir autorización Ley 1581 de 2012
   (casilla obligatoria + enlace a la política) en el registro. Nunca mostrar la palabra "E.164" al usuario.
7. **MFA:** fuera de alcance (`src/features/mfa/` está vacía). No diseñar pantallas de MFA.

---

## 2. Convenciones globales del backend (aplican a todo)

- Body máximo 64 KiB → `413 VALIDATION_ERROR "Cuerpo demasiado grande."`.
- Cabecera `X-Correlation-Id`: se propaga; ante un error mostrar "código de referencia" (el `correlationId`) para soporte, sin datos personales.
- `login`, `refresh` y `logout` fijan/limpian la cookie `kenko_refresh`.
- `refresh` es **silencioso** (sin pantalla): la UI lo ejecuta en segundo plano; si falla con `401`, redirigir al login.
  Si el backend revocó la familia por reúso, mostrar aviso de seguridad ("Cerramos tus sesiones por seguridad").
- `logout` es idempotente (siempre `200`): aunque falle la red, limpiar el estado local.
- `GET /health` (`{ data: { status: "ok" } }`) es solo para monitoreo, no es una vista.

---

## 3. Contrato del backend por endpoint

### 3.1 `POST /auth/register` — Crear cuenta (público) → `201`

| Campo | Tipo | Req | Formato / longitud / reglas |
| --- | --- | --- | --- |
| `firstName` | string | Sí | `trim`, 1–100, debe contener ≥ 1 letra Unicode |
| `lastName` | string | Sí | igual que `firstName` |
| `birthDate` | string | Sí | fecha ISO `YYYY-MM-DD`, no futura (≤ hoy UTC), no mayor a 120 años |
| `gender` | enum | Sí | `male \| female \| other` |
| `email` | string | Sí | `trim` + minúsculas, formato email, máx. 254 |
| `phone` | string | Sí | se normaliza a E.164 (quita espacios/guiones/puntos/paréntesis; `00`→`+`; 10 dígitos que empiezan en `3`→`+57`); final `^\+[1-9]\d{7,14}$` |
| `addressLine` | string | Sí | `trim`, 1–200 |
| `city` | string | Sí | `trim`, 1–100 |
| `documentType` | enum | Sí | `CC \| TI \| CE \| PA` (`trim` + mayúsculas) |
| `documentNumber` | string | Sí | normalizado (sin espacios/puntos/guiones, mayúsculas), `^[A-Z0-9]{4,20}$` |
| `password` | string | Sí | 8–128, los espacios cuentan, rechaza lista negra (`password`, `password123`, `12345678`, `123456789`, `qwerty123`, `colombia123`, `kenko1234`, insensible a mayúsculas) |
| `confirmPassword` | string | Sí | debe ser idéntica a `password`; no se almacena |

- **Salida a mostrar:** `201 { data: { userId, maskedEmail } }` (`maskedEmail` tipo `m***@dominio`).
  Mostrar: "Te enviamos un correo de bienvenida a m***@dominio". No reconstruir ni mostrar el email completo.
- **Errores → mensaje UI:**
  - `400 VALIDATION_ERROR` + `details` por campo → pintar bajo cada campo (ej. "La fecha no puede ser futura", "Las contraseñas no coinciden").
  - `409 REGISTER_CONFLICT "No se pudo completar el registro."` → "No pudimos crear tu cuenta con estos datos. Revisa tu documento y correo o intenta recuperar tu contraseña." (no indicar cuál existe).
  - `500 INTERNAL_ERROR` → "Tuvimos un problema. Intenta de nuevo más tarde." (+ código de referencia).

### 3.2 `POST /auth/login` — Entrar (público) → `200`

| Campo | Tipo | Req | Reglas |
| --- | --- | --- | --- |
| `documentType` | enum | Sí | `CC \| TI \| CE \| PA` (igual que registro) |
| `documentNumber` | string | Sí | `^[A-Z0-9]{4,20}$` normalizado (igual que registro) |
| `password` | string | Sí | 1–128, solo "no vacía" (sin reglas de complejidad al validar) |

- Límites: IP máx. 10/15 min; documento máx. 5/15 min.
- **Salida:** `200 { data: { accessToken, refreshToken, expiresIn: 900 } }` + cookie `kenko_refresh`.
  La UI debe usar `GET /auth/me` para el saludo, no decodificar el JWT.
- **Errores → mensaje UI:**
  - `400` formato → error por campo.
  - `401 UNAUTHORIZED "Credenciales inválidas."` (único, exista o no el usuario) → "El documento o la contraseña no son correctos." + enlace "¿Olvidaste tu contraseña?".
  - `429 RATE_LIMITED` → "Hiciste muchos intentos. Espera N segundos e intenta de nuevo." (cuenta regresiva con `Retry-After`).

### 3.3 `POST /auth/refresh` — Renovación silenciosa (público, token en body o cookie) → `200`

- Entrada: `refreshToken` opcional en body; se acepta por BODY (prioridad) o cookie `kenko_refresh`, nunca por URL. `400` si falta en ambos. Límite IP 20/15 min.
- Negocio: si la sesión está `rotated` (reúso), revoca toda la familia → `401`.
- **Salida:** `200` par nuevo + cookie rotada. Sin pantalla propia.
- **Errores → mensaje UI:** `401 "Credenciales inválidas."` → cerrar sesión local y pedir login. Mensaje de seguridad si aplica: "Cerramos tus sesiones por seguridad. Vuelve a entrar."

### 3.4 `POST /auth/logout` — Salir (público, token en body o cookie) → `200`

- Entrada: igual que refresh (`400` si falta en ambos). Límite IP 20/15 min.
- Acción: revoca **todas** las sesiones del usuario en todos los dispositivos + limpia cookie. Idempotente, siempre `200 { data: {} }`.
- **Salida a mostrar:** pantalla "Saliste de tu cuenta" + botón "Volver a entrar".
- **Errores:** ante `400`/`429`, igualmente limpiar el estado local y mostrar la pantalla de salida.

### 3.5 `POST /auth/password/forgot` — Pedir enlace (público) → `200`

| Campo | Tipo | Req | Reglas |
| --- | --- | --- | --- |
| `documentType` | enum | Sí | `CC \| TI \| CE \| PA` |
| `documentNumber` | string | Sí | `^[A-Z0-9]{4,20}$` normalizado |

- Límites: IP 10/15 min; documento 3/15 min; enfriamiento 1/60 s.
- **Salida:** siempre `200 { data: {} }` exista o no la cuenta.
  Mostrar: "Si tus datos son correctos, te enviamos un correo con el enlace. Revisa tu bandeja y spam."
- **Errores:** `400` formato → por campo. `429` → "Ya pediste un enlace hace poco. Espera N segundos."

### 3.6 `POST /auth/password/reset` — Crear nueva contraseña (público, token en body) → `200`

| Campo | Tipo | Req | Reglas |
| --- | --- | --- | --- |
| `token` | string | Sí | opaco, no vacío (sin validación de formato; va en BODY, nunca en URL) |
| `password` | string | Sí | misma política 8–128 + lista negra |
| `confirmPassword` | string | Sí | idéntica a `password` |

- Negocio: el hash del token debe estar activo (no usado, no invalidado, no vencido); la nueva ≠ actual; al éxito revoca sesiones.
- Límite IP 10/15 min.
- **Salida:** `200 {}` → "Tu contraseña cambió. Ahora entra con tu documento y tu nueva contraseña." + botón Ir a entrar.
- **Errores:** `400 VALIDATION_ERROR` (forma o "igual a la actual") → por campo.
  `400 PASSWORD_RESET_INVALID "El enlace no es válido o ha expirado."` → "Este enlace ya no sirve (se usó o venció). Pide uno nuevo." + botón reenviar.

### 3.7 `GET /auth/me` — Quién entró (requiere `Authorization: Bearer <JWT>`) → `200`

- **Salida:** `200 { data: { userId, firstName, email } }` → saludo "Hola, {firstName}".
- **Errores:** `401` (sin token, vencido o usuario borrado) → volver al login en silencio. Sin rate propio.

### 3.8 `POST /auth/password/change` — Cambiar contraseña (requiere `Bearer`) → `200`

| Campo | Tipo | Req | Reglas |
| --- | --- | --- | --- |
| `currentPassword` | string | Sí | no vacía |
| `newPassword` | string | Sí | política 8–128 + lista negra. El backend **no pide `confirmPassword`** (la confirmación es solo del frontend) |

- Negocio: actual debe coincidir; nueva ≠ actual; nueva no puede contener email, nombre ni apellido (insensible a mayúsculas).
  Revoca las sesiones de otras familias (conserva la actual). No publica eventos.
- Límites: IP 20/15 min + usuario 5 intentos/10 min.
- **Salida:** `200 {}` → "Tu contraseña cambió. Las otras sesiones se cerraron."
- **Errores:** `400` forma/igual → por campo; `400 "La nueva contraseña no puede contener tu correo o tu nombre."` → "Evita usar tu nombre o correo en la contraseña.";
  `401 "Contraseña actual incorrecta."` → "La contraseña actual no es correcta.";
  `401` JWT malo → re-login; `429` → cuenta regresiva.

### 3.9 `POST /auth/email/change` — Cambiar correo (requiere `Bearer`) → `200`

| Campo | Tipo | Req | Reglas |
| --- | --- | --- | --- |
| `newEmail` | string | Sí | `trim` + minúsculas, formato email, máx. 254 |
| `currentPassword` | string | Sí | no vacía (se verifica contra el hash) |

- Negocio: si `newEmail` es igual al actual → `200 { changed: false }` sin escribir ni evento (idempotente);
  si cambia → `200 { changed: true }` + evento `EmailChanged`. Correo ocupado → `409` genérico.
- Límites: iguales a cambio de contraseña.
- **Salida:** `false` → "Ya usas ese correo." `true` → "Tu correo cambió. Te avisamos al correo anterior."
- **Errores:** `400` formato → por campo; `401` contraseña → "La contraseña actual no es correcta.";
  `409 UPDATE_CONFLICT "No se pudo completar el cambio."` → "No pudimos usar ese correo. Revisa que esté bien escrito o usa otro.";
  `429` → cuenta regresiva.

### 3.10 Catálogo de errores transversales

| Código | HTTP | Cuándo | Mensaje backend | Mensaje UI sugerido |
| --- | --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | forma/negocio por campo | específico por campo (`details`) | pintar bajo el campo + cómo corregirlo |
| `REGISTER_CONFLICT` | 409 | email o documento ya existen | "No se pudo completar el registro." | "No pudimos crear tu cuenta con estos datos…" |
| `UPDATE_CONFLICT` | 409 | nuevo email ocupado | "No se pudo completar el cambio." | "No pudimos usar ese correo…" |
| `PASSWORD_RESET_INVALID` | 400 | token malo/vencido/usado | "El enlace no es válido o ha expirado." | "Este enlace ya no sirve. Pide uno nuevo." |
| `UNAUTHORIZED` | 401 | login/refresh/me/JWT | "Credenciales inválidas." | "El documento o la contraseña no son correctos." / re-login silencioso |
| `UNAUTHORIZED` | 401 | contraseña actual mala | "Contraseña actual incorrecta." | "La contraseña actual no es correcta." |
| `RATE_LIMITED` | 429 | límites | "Demasiadas solicitudes…" + headers | cuenta regresiva con `Retry-After` |
| `NOT_FOUND` | 404 | ruta inexistente | "Recurso no encontrado." | "Esa página no existe." |
| `PAYLOAD_TOO_LARGE` | 413 | body > 64 KiB | "Cuerpo demasiado grande." | "Los datos son demasiado grandes." |
| `INTERNAL_ERROR` | 500 | fallo no controlado | "Error interno. Intente de nuevo más tarde." | lo mismo + código de referencia |

---

## 4. Propuesta A — "Paso a paso guiado" (asistente por etapas)

- **Idea central:** una sola pregunta o grupo corto por pantalla, con barra de progreso y resumen antes de enviar. Lenguaje muy simple, botones grandes, cero jerga.
- **Ideal para:** adultos mayores y usuarios de bajo nivel digital; el público más crítico de una EPS.
- **Vistas y flujo:**
  1. `Bienvenida` → botones grandes [Crear cuenta] [Entrar] [¿Olvidaste tu contraseña?].
  2. `Registro` en 4 pasos: (1) Documento (tarjetas CC/TI/CE/PA + número) → (2) Nombres, apellidos, fecha, género → (3) Correo, teléfono, dirección, ciudad → (4) Contraseña + confirmación + casilla Ley 1581 ("Acepto el tratamiento de mis datos… ver política"). Luego `Resumen` → `Éxito` ("Cuenta creada, revisa m***@dominio").
  3. `Entrar`: documento + contraseña + [Entrar], enlace de recuperación.
  4. `Recuperar`: paso 1 documento → `Revisa tu correo` (pantalla de espera, anti-enumeración) → paso 2 nueva contraseña (llega por enlace del correo).
  5. `Mi cuenta`: saludo "Hola, {firstName}", tarjetas grandes [Cambiar contraseña] [Cambiar correo] [Salir de todos los dispositivos].
- **Componentes:** stepper "Paso 2 de 4", tarjetas seleccionables de documento y género, calendario nativo, medidor de contraseña simple, mostrar/ocultar contraseña, resumen de confirmación, pantalla de éxito con un solo botón principal.
- **Validaciones visuales:** error bajo el campo + icono y cómo arreglarlo ("El número debe tener entre 4 y 20 letras o números, sin puntos"). [Continuar] habilitado solo con el paso válido. Casilla Ley 1581 obligatoria.
- **Estados:** cargando = botón con spinner ("Creando tu cuenta…"); éxito = pantalla de confirmación; error = aviso + errores por campo; `429` = aviso con cuenta regresiva.
- **Ventajas:** menos errores; ideal móvil y adultos mayores; el resumen reduce registros fallidos.
- **Desventajas:** más clics para avanzados; requiere guardar borrador entre pasos.

## 5. Propuesta B — "Mi cuenta segura" (panel central + autenticación compacta)

- **Idea central:** autenticación delgada (login/registro en una tarjeta) y el valor en un panel de cuenta con "Centro de seguridad".
- **Ideal para:** usuarios frecuentes (30–55 años) que entran seguido a citas, certificados e historial.
- **Vistas y flujo:**
  1. `Acceso` (una tarjeta, pestañas Entrar | Crear cuenta). Entrar: documento + contraseña. Crear cuenta: formulario de una página con secciones plegables.
  2. `Recuperar` en 2 pantallas (pedir enlace → crear nueva).
  3. `Panel` con menú inferior (móvil) o lateral: `Inicio` ("Hola, {firstName}") · `Seguridad` (Contraseña [Cambiar], Correo [Cambiar], Sesiones [Salir de todos los dispositivos], aviso "Tu sesión dura 15 minutos, se renueva sola") · `Ayuda`.
  4. Cambios como modales/paneles laterales con confirmación por contraseña actual.
- **Componentes:** tabs, tarjetas de estado, modales de confirmación, badges de seguridad. Nota: el backend no expone lista de sesiones → mostrar solo "salir de todos", no tabla de dispositivos (suposición documentada).
- **Validaciones visuales:** validación al salir del campo (verde "Se ve bien" / rojo con corrección). Contraseña con checklist en vivo (8 caracteres, no común, sin tu nombre).
- **Estados:** cargando = esqueletos; éxito = toast + cierre de modal; error = toast + detalle por campo; sesión vencida = diálogo "Tu sesión terminó, vuelve a entrar" (intentar `refresh` silencioso primero).
- **Ventajas:** rápido para habituales; concentra lo sensible en un lugar predecible; escala a citas/documentos.
- **Desventajas:** el registro largo en una página puede abrumar a adultos mayores; exige buen responsive.

## 6. Propuesta C — "Te acompaño" (asistente conversacional, una cosa a la vez)

- **Idea central:** asistente ("Kenko te ayuda") con una pregunta por pantalla en lenguaje hablado + interruptor [Modo guiado | Ver formulario completo]. Tipografía grande, alto contraste.
- **Ideal para:** baja visión, baja lectura o móvil de gama baja; incluye texto grande y lectura en voz alta.
- **Vistas y flujo:**
  1. `Asistente` lineal: "¿Cuál es tu tipo de documento?" (CC/TI/CE/PA con explicación "CC = cédula de ciudadanía…") → "Escríbelo sin puntos ni guiones" → … → "Crea una contraseña…" → confirmación → `Éxito`.
  2. Mismo asistente para Entrar y Recuperar.
  3. `Mi cuenta` como en A + interruptores [Texto grande] [Alto contraste].
- **Componentes:** burbujas de chat + campo único grande, teclado numérico para documento/teléfono, tarjeta de ayuda ("¿Dónde está mi número?"), barra de progreso por puntos.
- **Validaciones visuales:** no avanza hasta corregir: "Ese número parece corto, mínimo 4 caracteres. Revísalo." + ejemplo. Jamás mostrar "E.164".
- **Estados:** cargando = "Un momento, estoy guardando…"; éxito = mensaje claro + siguiente paso; error = explicación simple + reintentar; `429` = "Espera un momento, te aviso cuando puedas seguir" con temporizador.
- **Ventajas:** la más accesible (foco visible, contraste, táctil ≥ 24px, sin depender del color); reduce abandono.
- **Desventajas:** más lenta para expertos; el audio exige cuidado con privacidad (no leer documentos en voz alta en público; Ley 1581).

---

## 7. Recomendación

**Elegir la Propuesta A (paso a paso guiado) como base, con el "Centro de seguridad" de la B.**

Justificación: en una EPS colombiana el riesgo real es el adulto mayor en un celular modesto, con CC y contraseña que olvida.
A minimiza errores de registro y recuperación (los flujos con más validaciones), respeta la anti-enumeración sin confundir
y ubica la casilla Ley 1581 donde corresponde. El panel `Mi cuenta / Seguridad` de B ordena lo autenticado
(cambiar contraseña, cambiar correo con `changed`, salir de todos). Dejar C como mejora posterior de accesibilidad
(texto grande, alto contraste) sobre la estructura de A, no como producto aparte.

---

## 8. Checklist de aceptación para el agente frontend

- [ ] Registro en pasos con validación por campo usando `details` de `VALIDATION_ERROR`.
- [ ] Mensajes de error con cómo corregirlo; `409`/`401` login/`200` forgot genéricos (sin revelar existencia).
- [ ] Login con documento + contraseña; tras login llamar `GET /auth/me` para el saludo.
- [ ] Refresh silencioso en segundo plano; ante `401` ir a login (+ aviso de seguridad si hubo revocación).
- [ ] Logout limpia estado local siempre y muestra "Saliste de tu cuenta".
- [ ] Forgot muestra el mismo mensaje exista o no la cuenta; respeta enfriamiento 60 s con cuenta regresiva.
- [ ] Reset lee el token del fragmento del enlace, lo envía en BODY; maneja `PASSWORD_RESET_INVALID` con botón "pedir nuevo enlace".
- [ ] Cambio de contraseña con confirmación solo en frontend + checklist (8 caracteres, no común, sin nombre/correo).
- [ ] Cambio de correo maneja `changed: true/false` y `409` genérico.
- [ ] `429` en cualquier pantalla: cuenta regresiva con `Retry-After`, sin reintentos automáticos agresivos.
- [ ] Casilla Ley 1581 obligatoria en registro + enlace a política (texto a definir por el equipo jurídico).
- [ ] Accesibilidad AA, móvil primero, objetivos táctiles grandes, errores con `aria-describedby`.
- [ ] Sin secretos/PII en logs o consola; `maskedEmail` tal cual llega; correo completo solo el que el usuario escribió.
