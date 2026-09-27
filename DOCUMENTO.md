# Laboratorio 3 — CRUD Serverless con AWS Lambda, API Gateway y DynamoDB

**Curso:** Cloud Computing — Universidad de Antioquia, 2026
**Entidad elegida:** Libros
**Servicio:** `crud-libros`

---

## 1. Descripción de la entidad y diseño de la tabla

La entidad modelada es **libro**, con seis atributos además del identificador:

| Atributo        | Tipo DynamoDB | Rol                                             |
| --------------- | ------------- | ----------------------------------------------- |
| `id`            | `S` (String)  | **Partition key** — UUID v4 generado en la Lambda |
| `titulo`        | `S`           | Atributo de negocio (obligatorio)               |
| `autor`         | `S`           | Partition key del GSI `autor-index` (obligatorio) |
| `anio`          | `N` (Number)  | Sort key del GSI `autor-index` (obligatorio)    |
| `genero`        | `S`           | Atributo de negocio (obligatorio)               |
| `disponible`    | `BOOL`        | Opcional, por defecto `true`                    |
| `creadoEn`      | `S`           | Marca de tiempo ISO, generada al crear          |
| `actualizadoEn` | `S`           | Marca de tiempo ISO, generada en PUT/PATCH      |

**Decisiones de diseño:**

- **Partition key `id` (UUID).** Un UUID distribuye las escrituras de forma uniforme entre las
  particiones de DynamoDB, evitando *hot partitions*. Usar el título o el ISBN habría acoplado la
  llave a un dato de negocio que puede cambiar o repetirse.
- **Sin sort key en la tabla base.** El acceso principal es puntual (`GetCommand` por `id`), un
  patrón clave-valor puro que no requiere ordenamiento dentro de la partición.
- **GSI `autor-index` (`autor` HASH + `anio` RANGE).** Permite responder "todos los libros de X"
  con un `Query` que lee solo esa partición, y devolverlos ya ordenados cronológicamente sin
  ordenar en la Lambda. `ProjectionType: ALL` evita una segunda lectura contra la tabla base.
- **`BillingMode: PAY_PER_REQUEST`.** Modo bajo demanda: no se paga capacidad reservada, ideal
  para un laboratorio con tráfico esporádico.
- **Nombre de tabla parametrizado** como `${self:service}-libros-${sls:stage}`, expuesto a las
  funciones mediante la variable de entorno `LIBROS_TABLE`. Así `dev` y `prod` nunca comparten
  datos y el nombre no queda quemado en el código.
- **Alias de atributos.** Todas las expresiones usan `ExpressionAttributeNames` (`#titulo`,
  `#anio`, …). En esta entidad ninguno es palabra reservada de DynamoDB, pero el patrón deja el
  código a prueba de futuros campos como `name`, `status`, `date` o `year`.

---

## 2. Diagrama de la arquitectura

```
                       ┌──────────────────────────┐
                       │  Cliente                  │
                       │  (Postman / Insomnia)     │
                       └────────────┬──────────────┘
                                    │  HTTPS
                                    ▼
                       ┌──────────────────────────┐
                       │  API Gateway (HTTP API)   │
                       │  7 rutas → 7 integraciones│
                       └────────────┬──────────────┘
                                    │
        ┌───────────┬───────────┬───┴───────┬───────────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼           ▼           ▼
     crear       listar     buscarPor    obtener   actualizar  actualizar   eliminar
   POST /libros GET /libros   Autor    GET /{id}   PUT /{id}    Parcial   DELETE /{id}
                          GET /autor/…             (UpdateCmd) PATCH /{id}
        │           │           │           │           │           │           │
        └───────────┴───────────┴─────┬─────┴───────────┴───────────┴───────────┘
                                      │  AWS SDK v3 (rol IAM de mínimo privilegio)
                                      ▼
                       ┌──────────────────────────────────────┐
                       │  Amazon DynamoDB                      │
                       │  Tabla: crud-libros-libros-dev        │
                       │    PK: id (S)                         │
                       │  GSI: autor-index (autor S, anio N)   │
                       └──────────────────────────────────────┘

   Cada Lambda escribe sus logs en Amazon CloudWatch Logs
   (/aws/lambda/crud-libros-dev-*)

   Todo el conjunto se crea y se destruye como una sola pila de AWS CloudFormation
   (`serverless deploy` / `serverless remove`)
```

---

## 3. Reflexión

### 3.1 ¿Por qué `Scan` puede ser costoso en tablas grandes y cuándo usar `Query`?

`Scan` **lee la tabla completa**: recorre todas las particiones y todos los elementos, y solo
después aplica el filtro. El costo en unidades de lectura (RCU) es proporcional al tamaño total
de la tabla, no al de la respuesta; filtrar con `FilterExpression` no reduce el cobro, porque el
filtro se aplica *después* de leer. En una tabla de un millón de libros, buscar los cinco de un
autor cuesta lo mismo que leerla entera, la latencia crece con el volumen, la operación se
devuelve paginada en bloques de 1 MB, y en modo aprovisionado puede consumir toda la capacidad y
provocar *throttling* al resto de la aplicación.

`Query`, en cambio, **usa la llave de partición para ir directo a los datos**: lee solo la
partición indicada y cobra únicamente por los elementos devueltos (más la posible porción
descartada por el filtro dentro de esa partición). Su costo depende del resultado, no de la tabla.

La regla práctica: **usar `Query` siempre que se conozca la llave de partición**, sobre la tabla
base o sobre un índice secundario creado precisamente para ese patrón de acceso. En este proyecto
`GET /libros/autor/{autor}` usa `Query` contra el GSI `autor-index` en lugar de un `Scan` con
filtro. `Scan` se reserva para casos legítimos y acotados: listados administrativos completos
—como el `GET /libros` de este laboratorio, que además está paginado con `Limit` y
`LastEvaluatedKey`—, migraciones o procesos analíticos por lotes.

### 3.2 ¿Qué ventajas tiene una Lambda por operación frente a una sola Lambda con todas las rutas?

- **Mínimo privilegio real.** Cada función puede recibir exactamente los permisos que necesita:
  `listar` no necesita `DeleteItem` ni `PutItem`. Con una Lambda monolítica, el rol debe ser la
  unión de todos los permisos, y un fallo en el enrutamiento interno expone operaciones
  destructivas.
- **Radio de impacto reducido.** Un error, un despliegue defectuoso o un agotamiento de
  concurrencia en `eliminar` no tumba las lecturas. Además se puede aplicar *reserved concurrency*
  por función.
- **Escalado y afinación independientes.** Memoria, *timeout* y concurrencia se ajustan por
  operación: `listar` puede necesitar más memoria que `obtener`, y `crear` un *timeout* distinto.
- **Observabilidad granular.** Cada función tiene su propio grupo de CloudWatch Logs y sus
  métricas de invocaciones, errores, duración y *throttles*, lo que hace evidente qué operación
  falla o se degrada sin filtrar un log común.
- **Arranques en frío más livianos.** Cada paquete carga solo el código de su operación (en un
  proyecto mayor, con *bundling* por función), en vez de todo el enrutador.
- **Despliegues y reversiones más seguros.** Se puede actualizar o revertir una sola operación,
  con versiones y alias por función.

El contrapeso: más recursos que gestionar, código común que compartir (aquí, los helpers de
`handler.js`) y más funciones susceptibles de arranque en frío. Para una API pequeña y de alto
tráfico, un solo Lambda con un router puede ser razonable; para un CRUD didáctico y para el
principio de mínimo privilegio, una función por operación es la opción correcta.

### 3.3 ¿Qué pasaría si las funciones tuvieran permiso `dynamodb:*` sobre `*`?

Se rompería por completo el principio de mínimo privilegio, y el impacto sería:

- **Acceso a toda la cuenta.** `Resource: "*"` abarca *todas* las tablas de la cuenta en esa
  región (y con un ARN sin restricción, de cualquier región): otros laboratorios, otros servicios,
  datos de otros equipos. La Lambda de libros podría leer o borrar la tabla de un proyecto ajeno.
- **Acciones administrativas.** `dynamodb:*` no es solo CRUD: incluye `DeleteTable`,
  `CreateTable`, `UpdateTable`, `PutResourcePolicy`, `RestoreTableFromBackup`, `ExportTableToPointInTime`.
  Un error de código o una inyección podrían **eliminar tablas completas** o exfiltrar datos a un
  bucket S3.
- **Escalada del impacto de cualquier vulnerabilidad.** Si un atacante logra ejecutar código en
  esa Lambda (por ejemplo, vía una dependencia comprometida), hereda todos esos permisos: el
  compromiso de una función se convierte en el compromiso de la base de datos de la cuenta entera.
- **Costos e indisponibilidad.** Un `Scan` accidental sobre tablas enormes ajenas, o escrituras
  masivas, generan cobros inesperados y *throttling* de servicios en producción.
- **Auditoría y cumplimiento.** Se pierde la trazabilidad de qué componente puede hacer qué;
  revisiones de seguridad, AWS IAM Access Analyzer o AWS Config marcarían la política como
  demasiado permisiva.

En este proyecto, en cambio, la política enumera cinco acciones sobre
`Fn::GetAtt: [LibrosTable, Arn]` y restringe `dynamodb:Query` al ARN
`.../index/autor-index`. El daño máximo que puede causar un fallo en el código queda acotado a
los datos de esta misma tabla — que es exactamente lo que buscaba el laboratorio.

---

## 4. Retos opcionales implementados

| Bono                                                 | Implementación                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Búsqueda por atributo distinto al `id` con GSI + `Query` | `GET /libros/autor/{autor}` → `QueryCommand` sobre `autor-index`               |
| Paginación en `listar` con `Limit` y `LastEvaluatedKey`  | `GET /libros?limit=N&cursor=<base64>`, devuelve `cursor` para la página siguiente |
| `PATCH` para actualizar solo los campos enviados         | `PATCH /libros/{id}` → `UpdateExpression` construido dinámicamente               |
