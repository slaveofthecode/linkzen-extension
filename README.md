# 🚀 LinkZen - Roadmap de Desarrollo

Extensión de Google Chrome (Manifest V3) diseñada para eliminar la barra de favoritos tradicional, centralizando los accesos directos clave en un único icono limpio y ofreciendo un motor de auditoría para limpiar URLs obsoletas.

## 🛠️ Stack Tecnológico

- **Core:** TypeScript, Vite.
- **Estilos:** Tailwind CSS.
- **APIs de Chrome:** `chrome.bookmarks`, `chrome.storage`, `chrome.tabs`.
- **Entorno de desarrollo:** macOS, Cursor, Bun / Node.js.

---

## 🗺️ Fases del Proyecto

### Stage 1: Scaffold y Configuración Base

- [x] Inicializar proyecto con Vite + TypeScript.
- [x] Crear estructura de directorios (`src/background`, `src/popup`, `src/dashboard`).
- [x] Configurar el `manifest.json` (Manifest V3) con permisos de `bookmarks` y `storage`.
- [x] Configurar Tailwind CSS para los estilos de la interfaz.

### Stage 2: Módulo Launcher (El Menú Único Minimalista)

- [x] Diseñar el Popup flotante que se abre al hacer clic en el único icono de la barra.
- [x] Crear las secciones/categorías fijas (Ej: _Música, Trabajo, AI, Lecturas_).
- [x] Implementar la lectura de enlaces clave mediante almacenamiento local o marcadores agrupados.
- [x] Permitir abrir los links directamente en la pestaña actual o nueva.

### Stage 3: Motor de Auditoría y Red (`fetch`)

- [x] Desarrollar el script en el background que lea la API `chrome.bookmarks.getTree()`.
- [x] Implementar función de verificación por lotes con `fetch` y control de concurrencia.
- [x] Lógica de clasificación:
  - **Activos:** Código 200 OK.
  - **Rotos:** Errores 404, 500, o fallos de red.
  - **Sospechosos:** Discrepancia entre el título guardado y el título real de la página.

### Stage 4: Dashboard de Resolución Interactiva

- [x] Crear la vista `dashboard.html` como pestaña completa de auditoría.
- [x] Renderizar la lista de enlaces problemáticos detectados.
- [x] Añadir botones de acción rápida por enlace: **[Borrar]**, **[Actualizar Nombre]**, **[Mantener]**.
- [x] Conectar los botones con los métodos nativos `chrome.bookmarks.remove()` y `chrome.bookmarks.update()`.

### Stage 5: Pruebas Locales y QA en Mac

- [ ] Compilar con Vite (`npm run build`).
- [ ] Cargar como extensión descomprimida en `chrome://extensions/`.
- [ ] Probar rendimiento con un volumen alto de marcadores.

### Stage 6: Publicación en Chrome Web Store

- [ ] Generar assets finales (iconos de 128x128, capturas de pantalla).
- [ ] Empaquetar en `.zip`.
- [ ] Subir al Developer Dashboard y enviar a revisión.
