import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { createLazyHandler, unavailable, type Handler } from '../src/config';
/** Azure Functions v4 transport adapter; the application JWT authenticates callers. */
export function createAzureHandler(handle: Handler) {
  return async (request: HttpRequest): Promise<HttpResponseInit> => {
    let response: Response;
    try {
      const headers = new Headers();
      const token = request.headers.get('authorization');
      if(token) headers.set('authorization',token);
      response = await handle(new Request('https://application.invalid/check-export',{method:request.method,headers}));
    } catch { response=unavailable(); }
    return {status:response.status, headers:Object.fromEntries(response.headers), body:await response.text()};
  };
}
app.http('checkExport',{methods:['POST','GET'],authLevel:'anonymous',route:'check-export',handler:createAzureHandler(createLazyHandler(()=>process.env))});
