import { Context, APIGatewayEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  S3Client,
  DeleteObjectsCommand,
  DeleteObjectsCommandOutput,
  ObjectIdentifier,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  SendMessageBatchCommand,
  SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { md5hash } from "aws-cdk-lib/core/lib/helpers-internal";

/**
 * Interface for the request body of the PreRender API recache endpoint.
 */
interface PreRenderRequestBody {
  /**
   * The prerender token used to authenticate the request.
   */
  prerenderToken: string;
  /**
   * The URL to recache. Optional if `urls` is provided.
   */
  url?: string;
  /**
   * An array of URLs to recache. Optional if `url` is provided.
   */
  urls?: string[];
}

const QueueUrl = process.env.SQS_QUEUE_URL;
const Bucket = process.env.PRERENDER_CACHE_BUCKET;

export const MAX_URLS = 1000;
// export const PARAM_PREFIX = "prerender/recache/tokens"; // TO-DO: parse TOKEN_SECRET into tokens and URLs

const sqsClient = new SQSClient({});
const s3Client = new S3Client({});

/**
 * Handles the recaching of URLs and returns a response with the recached URLs.
 * @param {APIGatewayEvent} event - The event object passed by AWS API Gateway.
 * @param {Context} _context - The context object passed by AWS Lambda.
 * @returns {Promise<APIGatewayProxyResult>} - A promise that resolves to an APIGatewayProxyResult object.
 */
export const handler = async (
  event: APIGatewayEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  let urlsToRecache: string[];

  try {
    urlsToRecache = await getUrlsToRecache(event.body || "");
    console.log(urlsToRecache);
  } catch (error) {
    return {
      statusCode: 403,
      body: JSON.stringify({
        error,
        message: `Token does not exist or is misconfigured`,
      }),
    };
  }

  if (urlsToRecache.length > MAX_URLS) {
    console.log(
      `Too many urls, received ${urlsToRecache.length}, maximum is ${MAX_URLS}`
    );
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `Too many urls, maximum is ${MAX_URLS}`,
      }),
    };
  }

  if (urlsToRecache.length === 0) {
    console.log("No valid urls to recache");
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No urls to recache",
      }),
    };
  }

  console.log(await deleteCacheContentForUrls(urlsToRecache));
  await queueRecachingUrls(urlsToRecache);

  return {
    statusCode: 200,
    body: JSON.stringify({
      urlsToRecache,
    }),
  };
};

// Use SecretsManager
const secret_name = process.env.TOKEN_SECRET;
const smClient = new SecretsManagerClient({});
/**
 * Parses the given request body and returns an array of URLs to recache.
 * @param body - The request body to parse.
 * @returns An array of URLs to recache.
 * @throws An error if the token is not valid or if no parameters are returned.
 */
const getUrlsToRecache = async (body: string): Promise<string[]> => {
  const requestBody: PreRenderRequestBody = JSON.parse(body);

  let urls: string[];
  if (requestBody.urls !== undefined) {
    urls = requestBody.urls;
  } else if (requestBody.url !== undefined) {
    urls = [requestBody.url];
  } else {
    urls = [];
  }

  // Use SecretsManager

  const token = requestBody.prerenderToken;

  //  { "tokenABC": "https://URL_A,https://URL_B,...", ..., "tokenXYZ":"https://URL_Y,https://URL_Z" }

  interface TokenSecret {
    [key: string]: string;
  }

  // const prerenderToken = "tokenabc" // passed into recache function
  // const recacheUrl = "" // url to be recached

  // var secretsString = "{\"token11233\": \"https\", \"tokenabc\": \"https://aligent.com,https://example.com\"}"; // value from secrets manager

  console.log(`Looking for allowed urls in secretsmanager:${secret_name}`);

  const getAllowedUrls = new GetSecretValueCommand({
    SecretId: secret_name,
  });
  console.log(getAllowedUrls);

  // const ssmResponse = await ssmClient.send(getAllowedUrls);
  const smResponse = await smClient.send(getAllowedUrls);

  if (smResponse.SecretString === undefined) {
    throw "No secret found";
  }

  const secretsString = JSON.parse(smResponse.SecretString);
  var secretsData: TokenSecret = JSON.parse(secretsString); // parse data and define it as token secret

  const allowedUrls = secretsData[token].split(","); // get comma delimited urls from string

  // for (const url of urls) {
  //   for (const allowedUrl of allowedUrls) {
  //     if (allowedUrls && url.startsWith(allowedUrl)) {
  //       // checks that allowedUrls is not undefined or empty and that it includes the requested url
  //       // TODO: allow recache
  //     }
  //   }
  // }

  // allowedURLs : https://www.aligent.com.au,https://staging.aligent.com.au
  // urls: https://www.aligent.com.au/abc,https://testing.aligent.com.au/abc

  console.log(`Allowed urls for ${token}: ${allowedUrls.join(", ")}`);

  const isValidUrlForToken = (url: string): boolean =>
    allowedUrls.find(a => url.includes(a)) !== undefined;

  return urls.filter(isValidUrlForToken);
};

/**
 * Deletes the cache content for the given URLs from the S3 bucket.
 * @param urlsToRecache - An array of URLs to delete from the cache.
 * @returns A Promise that resolves to the output of the DeleteObjectsCommand.
 */
const deleteCacheContentForUrls = async (
  urlsToRecache: string[]
): Promise<DeleteObjectsCommandOutput> => {
  const mapUrlToKey = (Key: string): ObjectIdentifier => {
    return { Key };
  };

  console.log(`Deleting ${urlsToRecache.length} objects from ${Bucket}`);

  const deleteObjects = new DeleteObjectsCommand({
    Bucket,
    Delete: {
      Objects: urlsToRecache.map(mapUrlToKey),
      Quiet: true,
    },
  });

  return await s3Client.send(deleteObjects);
};

/**
 * Queues the given URLs for recaching.
 * @param urlsToRecache An array of URLs to recache.
 */
const queueRecachingUrls = async (urlsToRecache: string[]) => {
  const generateEntry = (url: string): SendMessageBatchRequestEntry => {
    return {
      DelaySeconds: 1,
      Id: md5hash(url) + url.replace(/[^A-Z0-9_-]+/gi, "_").slice(-47),
      MessageBody: url,
    };
  };

  const urlsToRequest = chunkUrls(urlsToRecache, 10);

  const messages = urlsToRequest.map((urls: string[]) => {
    return new SendMessageBatchCommand({
      QueueUrl,
      Entries: urls.map(generateEntry),
    });
  });

  console.log(`Sending ${messages.length} recaching message batches`);

  await Promise.all(messages.map(m => sqsClient.send(m)));
};

/**
 * Splits an array of strings into smaller arrays of a specified size.
 * @param array - The array of strings to be split.
 * @param chunkSize - The maximum size of each chunk.
 * @returns An array of arrays, where each inner array contains a maximum of `chunkSize` strings.
 */
const chunkUrls = (array: string[], chunkSize: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    const chunk = array.slice(i, i + chunkSize);
    chunks.push(chunk);
  }

  return chunks;
};
