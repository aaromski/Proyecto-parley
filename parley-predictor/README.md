# Motor de análisis de partidos

Aplicación web en español para normalizar datos de partidos, configurar mercados y reglas, y solicitar dictámenes estadísticos mediante dos etapas de Gemini.

## Preparación

Requiere Node.js 20.9 o posterior y npm.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Abre `http://localhost:3000`. Antes de analizar, configura `GEMINI_API_KEY` en `parley-predictor/.env.local`; la clave se usa exclusivamente en el servidor. `GEMINI_MODEL` es opcional y por defecto usa `gemini-3.5-flash-lite`. No introduzcas claves en la interfaz ni las guardes en el repositorio.

## Verificaciones

```powershell
npm test
npm run lint
npm run build
```

## Datos y límites

La configuración de mercados y reglas se guarda en el almacenamiento local de este navegador. El texto del partido permanece en la sesión de la página. Al analizar, los datos se envían al servidor y se procesan mediante Gemini; revisa las políticas vigentes del proveedor antes de incluir información sensible.

Las probabilidades son estimaciones sujetas a incertidumbre, no garantías ni recomendaciones de apuesta. Los factores de riesgo iniciales son neutrales y no están calibrados con datos históricos.
