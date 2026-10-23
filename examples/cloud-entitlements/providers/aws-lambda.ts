import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createLazyHandler, unavailable, type Handler } from '../src/config';
/** API Gateway HTTP API v2 adapter. Authentication comes from the application JWT. */
export function createLambdaHandler(handle: Handler) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    let response: Response;
    try {
      const headers = new Headers();
      for (const [name,value] of Object.entries(event.headers)) {
        if (name.toLowerCase()==='authorization' && value) headers.set('authorization',value);
      }
      response = await handle(new Request('https://application.invalid/check-export', {method:event.requestContext.http.method, headers}));
    } catch { response = unavailable(); }
    return {statusCode:response.status, headers:Object.fromEntries(response.headers), body:await response.text(), isBase64Encoded:false};
  };
}
/** Configure environment variables on a regional Lambda using Node.js 22 or 24. */
export const handler = createLambdaHandler(createLazyHandler(() => process.env));
