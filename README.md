# CRUD Serverless de Libros — Laboratorio 3 (Cloud Computing, UdeA 2026)

API REST completamente serverless para administrar una colección de **libros**, construida con
**AWS Lambda + API Gateway (HTTP API) + Amazon DynamoDB**, definida como infraestructura como
código con **Serverless Framework v4**.

```
Cliente (Postman / Insomnia)
        │
        ▼
API Gateway (HTTP API)
        │
        ▼
AWS Lambda  ──►  7 funciones independientes (una por operación)
        │
        ▼
Amazon DynamoDB  ──►  tabla crud-libros-libros-dev  +  GSI autor-index

Logs de cada función → Amazon CloudWatch
Todo se crea con un solo `serverless deploy` (pila de AWS CloudFormation)
```

## API desplegada

La API esta desplegada y en funcionamiento en la region `us-east-1`:

```
https://0xmetp1wl6.execute-api.us-east-1.amazonaws.com
```

Ejemplo directo desde el navegador (solo GET):
[https://0xmetp1wl6.execute-api.us-east-1.amazonaws.com/libros](https://0xmetp1wl6.execute-api.us-east-1.amazonaws.com/libros)

## Entidad

| Atributo     | Tipo    | Obligatorio | Descripción                          |
| ------------ | ------- | ----------- | ------------------------------------ |
| `id`         | String  | generado    | **Partition key** (UUID v4)          |
| `titulo`     | String  | sí          | Título del libro                     |
| `autor`      | String  | sí          | Autor (partition key del GSI)        |
| `anio`       | Number  | sí          | Año de publicación (1450–2100)       |
| `genero`     | String  | sí          | Género literario                     |
| `disponible` | Boolean | no          | Si está disponible (default `true`)  |
| `creadoEn`   | String  | generado    | Fecha ISO de creación                |
| `actualizadoEn` | String | generado  | Fecha ISO de la última modificación  |

## Endpoints

| Método   | Ruta                    | Función             | Respuesta esperada                  |
| -------- | ----------------------- | ------------------- | ----------------------------------- |
| `POST`   | `/libros`               | `crear`             | `201` con el registro · `400`       |
| `GET`    | `/libros`               | `listar`            | `200` con la lista (paginada)       |
| `GET`    | `/libros/{id}`          | `obtener`           | `200` · `404` si no existe          |
| `PUT`    | `/libros/{id}`          | `actualizar`        | `200` · `400` · `404`               |
| `DELETE` | `/libros/{id}`          | `eliminar`          | `200` con confirmación · `404`      |
| `GET`    | `/libros/autor/{autor}` | `buscarPorAutor`    | `200` — **bono**: GSI + `Query`     |
| `PATCH`  | `/libros/{id}`          | `actualizarParcial` | `200` · `400` · `404` — **bono**    |

Cualquier fallo inesperado contra DynamoDB responde `500` y queda registrado en CloudWatch.

## Requisitos previos

- Node.js 20 o superior
- Serverless Framework v4: `npm install -g serverless`
- Cuenta en [app.serverless.com](https://app.serverless.com) (organización)
- Credenciales de AWS configuradas (`aws configure` o proveedor conectado en el dashboard)
  con permisos sobre Lambda, API Gateway, DynamoDB, IAM, CloudFormation, S3 y CloudWatch Logs

> **Importante:** en `serverless.yml`, el campo `org:` debe coincidir con el nombre de **tu**
> organización en app.serverless.com. Está puesto como `universidaddeantioquia`.

## Instalación

```bash
npm install
```

## Despliegue en AWS

```bash
serverless deploy
```

Al finalizar, la terminal imprime la URL base de la API. Verificar en la consola de AWS:

- **Lambda** — 7 funciones (`crud-libros-dev-crear`, `crud-libros-dev-listar`, …) y su variable
  de entorno `LIBROS_TABLE`.
- **API Gateway** — la HTTP API con las 7 rutas.
- **DynamoDB** — tabla `crud-libros-libros-dev` con `id` como partition key y el índice `autor-index`.
- **CloudFormation** — pila `crud-libros-dev` con todos los recursos generados.
- **CloudWatch Logs** — grupos `/aws/lambda/crud-libros-dev-*`.

## Pruebas locales

El código local necesita una tabla real, así que **primero se despliega** y luego:

```bash
serverless offline
```

El modo offline usa las credenciales locales para conectarse a la tabla real en AWS.
La API queda en `http://localhost:3000`.

## Pruebas con Postman / Insomnia

Importar `postman_collection.json`. La colección trae 15 requests, incluidos los casos de error
(`400` y `404`), y guarda automáticamente el `id` del libro creado en la variable `libroId`.

Cambiar la variable de colección `baseUrl`:

- Local: `http://localhost:3000`
- AWS: `https://0xmetp1wl6.execute-api.us-east-1.amazonaws.com`

### Ejemplos con curl

```bash
BASE="https://0xmetp1wl6.execute-api.us-east-1.amazonaws.com"

# Crear (201)
curl -X POST "$BASE/libros" -H "Content-Type: application/json" -d '{
  "titulo": "Cien años de soledad",
  "autor": "Gabriel García Márquez",
  "anio": 1967,
  "genero": "Realismo mágico",
  "disponible": true
}'

# Listar con paginación
curl "$BASE/libros?limit=1"
curl "$BASE/libros?limit=1&cursor=<cursor-devuelto>"

# Buscar por autor (Query sobre el GSI, no Scan)
curl "$BASE/libros/autor/Gabriel%20Garc%C3%ADa%20M%C3%A1rquez"

# Obtener / Actualizar / Parcial / Eliminar
curl "$BASE/libros/<id>"
curl -X PUT "$BASE/libros/<id>" -H "Content-Type: application/json" -d '{"titulo":"...","autor":"...","anio":1967,"genero":"Novela"}'
curl -X PATCH "$BASE/libros/<id>" -H "Content-Type: application/json" -d '{"disponible":false}'
curl -X DELETE "$BASE/libros/<id>"

# Casos de error
curl -X POST "$BASE/libros" -H "Content-Type: application/json" -d '{"titulo":"sin autor"}'   # 400
curl "$BASE/libros/00000000-0000-0000-0000-000000000000"                                      # 404
```

## Paginación

`GET /libros` responde:

```json
{
  "items": [ ... ],
  "total": 1,
  "cursor": "eyJpZCI6IjNmMi0uLi4ifQ=="
}
```

`cursor` es el `LastEvaluatedKey` de DynamoDB codificado en base64. Si es `null`, no hay más
páginas. Para pedir la siguiente: `GET /libros?limit=10&cursor=<cursor>`.

## Seguridad — mínimo privilegio

El rol IAM solo permite `PutItem`, `GetItem`, `Scan`, `UpdateItem` y `DeleteItem` **sobre el ARN
de esta tabla**, y `Query` **únicamente sobre el índice `autor-index`**. Ninguna función puede
tocar otras tablas de la cuenta ni ejecutar acciones administrativas (`CreateTable`, `DeleteTable`).

## Limpieza de recursos

Al terminar la sustentación:

```bash
serverless remove
```

## Estructura del proyecto

```
Laboratorio3/
├── handler.js                 # Lógica de las 7 funciones Lambda
├── serverless.yml             # Infraestructura como código
├── package.json
├── postman_collection.json    # Colección de pruebas
├── DOCUMENTO.md               # Documento técnico y reflexión
├── README.md
└── .gitignore
```
