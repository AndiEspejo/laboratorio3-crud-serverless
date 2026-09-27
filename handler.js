const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const TABLE = process.env.LIBROS_TABLE;
const AUTOR_INDEX = process.env.AUTOR_INDEX;

const db = DynamoDBDocumentClient.from(new DynamoDBClient(), {
  marshallOptions: { removeUndefinedValues: true },
});

const respuesta = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const leerBody = (event) => {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return null;
  }
};

const CAMPOS = {
  titulo: (v) =>
    typeof v === "string" && v.trim()
      ? null
      : '"titulo" es obligatorio y debe ser texto',
  autor: (v) =>
    typeof v === "string" && v.trim()
      ? null
      : '"autor" es obligatorio y debe ser texto',
  anio: (v) =>
    Number.isInteger(v) && v >= 1450 && v <= 2100
      ? null
      : '"anio" debe ser un entero entre 1450 y 2100',
  genero: (v) =>
    typeof v === "string" && v.trim()
      ? null
      : '"genero" es obligatorio y debe ser texto',
  disponible: (v) =>
    typeof v === "boolean" ? null : '"disponible" debe ser true o false',
};

const OBLIGATORIOS = ["titulo", "autor", "anio", "genero"];

const validar = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return "El cuerpo debe ser un JSON valido";
  for (const campo of OBLIGATORIOS) {
    if (data[campo] === undefined) return `"${campo}" es obligatorio`;
    const error = CAMPOS[campo](data[campo]);
    if (error) return error;
  }
  if (data.disponible !== undefined) {
    const error = CAMPOS.disponible(data.disponible);
    if (error) return error;
  }
  return null;
};

const validarParcial = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return "El cuerpo debe ser un JSON valido";
  const campos = Object.keys(data).filter((k) => k in CAMPOS);
  if (campos.length === 0)
    return `Debe enviar al menos uno de: ${Object.keys(CAMPOS).join(", ")}`;
  for (const campo of campos) {
    const error = CAMPOS[campo](data[campo]);
    if (error) return error;
  }
  return null;
};

const armarUpdate = (data) => {
  const sets = [];
  const names = {};
  const values = {};
  for (const campo of Object.keys(CAMPOS)) {
    if (data[campo] === undefined) continue;
    sets.push(`#${campo} = :${campo}`);
    names[`#${campo}`] = campo;
    values[`:${campo}`] = data[campo];
  }
  sets.push("#actualizadoEn = :actualizadoEn");
  names["#actualizadoEn"] = "actualizadoEn";
  values[":actualizadoEn"] = new Date().toISOString();
  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
};

const esNoEncontrado = (err) =>
  err.name === "ConditionalCheckFailedException" ||
  String(err.__type || "").includes("ConditionalCheckFailedException");

module.exports.crear = async (event) => {
  const data = leerBody(event);
  const error = validar(data);
  if (error) return respuesta(400, { error });

  const item = {
    id: randomUUID(),
    titulo: data.titulo.trim(),
    autor: data.autor.trim(),
    anio: data.anio,
    genero: data.genero.trim(),
    disponible: data.disponible ?? true,
    creadoEn: new Date().toISOString(),
  };

  try {
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(id)",
      })
    );
    return respuesta(201, item);
  } catch (err) {
    console.error("Error al crear libro:", err);
    return respuesta(500, { error: "No fue posible crear el libro" });
  }
};

module.exports.listar = async (event) => {
  const qs = (event && event.queryStringParameters) || {};

  let limit;
  if (qs.limit !== undefined) {
    limit = Number(qs.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return respuesta(400, {
        error: '"limit" debe ser un entero entre 1 y 100',
      });
  }

  let exclusiveStartKey;
  if (qs.cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(qs.cursor, "base64").toString("utf8")
      );
    } catch {
      return respuesta(400, { error: '"cursor" no es valido' });
    }
  }

  try {
    const { Items, LastEvaluatedKey } = await db.send(
      new ScanCommand({
        TableName: TABLE,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    return respuesta(200, {
      items: Items,
      total: Items.length,
      cursor: LastEvaluatedKey
        ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
        : null,
    });
  } catch (err) {
    console.error("Error al listar libros:", err);
    return respuesta(500, { error: "No fue posible listar los libros" });
  }
};

module.exports.buscarPorAutor = async (event) => {
  const crudo = (event.pathParameters && event.pathParameters.autor) || "";
  const autor = decodeURIComponent(crudo).trim();
  if (!autor) return respuesta(400, { error: '"autor" es obligatorio' });

  try {
    const { Items } = await db.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: AUTOR_INDEX,
        KeyConditionExpression: "#autor = :autor",
        ExpressionAttributeNames: { "#autor": "autor" },
        ExpressionAttributeValues: { ":autor": autor },
        ScanIndexForward: true,
      })
    );
    return respuesta(200, { autor, items: Items, total: Items.length });
  } catch (err) {
    console.error("Error al buscar por autor:", err);
    return respuesta(500, { error: "No fue posible buscar por autor" });
  }
};

module.exports.obtener = async (event) => {
  const { id } = event.pathParameters;
  try {
    const { Item } = await db.send(
      new GetCommand({ TableName: TABLE, Key: { id } })
    );
    if (!Item) return respuesta(404, { error: "Libro no encontrado" });
    return respuesta(200, Item);
  } catch (err) {
    console.error("Error al consultar libro:", err);
    return respuesta(500, { error: "No fue posible consultar el libro" });
  }
};

module.exports.actualizar = async (event) => {
  const { id } = event.pathParameters;
  const data = leerBody(event);
  const error = validar(data);
  if (error) return respuesta(400, { error });

  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id },
        ...armarUpdate(data),
        // Sin esto DynamoDB crearia un registro nuevo cuando el id no existe
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      })
    );
    return respuesta(200, Attributes);
  } catch (err) {
    if (esNoEncontrado(err))
      return respuesta(404, { error: "Libro no encontrado" });
    console.error("Error al actualizar libro:", err);
    return respuesta(500, { error: "No fue posible actualizar el libro" });
  }
};

module.exports.actualizarParcial = async (event) => {
  const { id } = event.pathParameters;
  const data = leerBody(event);
  const error = validarParcial(data);
  if (error) return respuesta(400, { error });

  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id },
        ...armarUpdate(data),
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      })
    );
    return respuesta(200, Attributes);
  } catch (err) {
    if (esNoEncontrado(err))
      return respuesta(404, { error: "Libro no encontrado" });
    console.error("Error al actualizar parcialmente el libro:", err);
    return respuesta(500, { error: "No fue posible actualizar el libro" });
  }
};

module.exports.eliminar = async (event) => {
  const { id } = event.pathParameters;
  try {
    const { Attributes } = await db.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { id },
        // Sin esto DynamoDB responderia 200 aunque el id no existiera
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_OLD",
      })
    );
    return respuesta(200, {
      mensaje: "Libro eliminado correctamente",
      libro: Attributes,
    });
  } catch (err) {
    if (esNoEncontrado(err))
      return respuesta(404, { error: "Libro no encontrado" });
    console.error("Error al eliminar libro:", err);
    return respuesta(500, { error: "No fue posible eliminar el libro" });
  }
};
