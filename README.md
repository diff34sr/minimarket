# Minimarket

Sistema de ventas del minimarket. Funciona en la red wifi del local: la PC guarda todo y los teléfonos se conectan a ella. No necesita internet para vender.

## Uso diario

- Al encender la PC, Minimarket se abre solo en el navegador.
- Si no se abrió: doble clic en **Minimarket** en el escritorio.
- En la barra de tareas queda una ventana negra minimizada, **"Minimarket - NO CERRAR"**. Si se cierra, los teléfonos dejan de conectarse: vuelve a abrir **Minimarket** desde el escritorio.
- Si se corta el wifi, el teléfono sigue cobrando y envía las ventas cuando vuelve la conexión.

## Usuarios

- PINs iniciales: administradora `1234`, cajero `0000`. **Cambiarlos el primer día** en Gestión → Usuarios.
- Cada cajero tiene su propio usuario y PIN (Gestión → Usuarios → + Nuevo), para saber quién hizo cada venta.

## Agregar un teléfono

Se hace una sola vez por teléfono, con Chrome:

1. Conectar el teléfono al wifi del local.
2. En la PC, abrir Minimarket: abajo aparece la dirección para el teléfono, por ejemplo `192.168.1.20:3000/pos.html`.
3. En el teléfono, abrir Chrome y escribir `chrome://flags` en la barra de direcciones.
4. Buscar **Insecure origins treated as secure**. En el cuadro escribir `http://` + la dirección sin `/pos.html` (ejemplo: `http://192.168.1.20:3000`), cambiar a **Enabled** y tocar **Relaunch**.
5. Abrir la dirección completa del paso 2. Permitir la cámara cuando lo pida.
6. Menú ⋮ → **Agregar a la pantalla principal**, para abrirla como una app.

## Actualizar

Cuando soporte avise: doble clic en **Actualizar Minimarket** en el escritorio. Necesita internet. Antes de actualizar guarda una copia de los datos en la carpeta `copias`.

## Si algo falla

| Problema | Qué hacer |
|---|---|
| El teléfono dice "Sin conexión con el PC" | Revisar que la PC esté encendida y en el mismo wifi; abrir **Minimarket** en el escritorio. |
| El teléfono no abre la cámara | Repetir el paso 4 de "Agregar un teléfono"; se puede escribir el código a mano. |
| La dirección del teléfono cambió | La PC cambió de dirección en el wifi: pedir a soporte que la fije en el router. |

## Soporte técnico

- Instalación (una vez, en la carpeta clonada): clic derecho en `Instalar.bat` → Ejecutar como administrador. Requiere Node.js 24 y Git.
- Arrancar a mano: `node server.js`. Datos en `minimarket.db` (no se sube a git; copias en `copias/`).
- Tests: `npm test`.
- Demo con datos de prueba: `DB_PATH=demo.db node seed/demo.js` y luego `DB_PATH=demo.db RECEIPTS_DIR=demo.db-receipts node server.js`. Nunca correr el seed sin `DB_PATH`.
