import type { CloudFrontRequestEvent, CloudFrontResultResponse } from 'aws-lambda';
import { createConfiguredHandler, unavailable, type Environment, type Handler } from '../src/config';
import { loadEdgeConfiguration } from './aws-edge-config';
/** Use an origin-request association and a caching-disabled CloudFront behavior. */
export function createLambdaEdgeHandler(load: () => Promise<Environment>) {
  let configuration: Environment | undefined;
  let handle: Handler | undefined;
  return async (event: CloudFrontRequestEvent): Promise<CloudFrontResultResponse> => {
    let response: Response;
    try {
      const next = await load();
      if(next!==configuration || !handle){handle=createConfiguredHandler(next);configuration=next;}
      const request = event.Records[0]?.cf.request;
      if(!request) throw new Error('Missing CloudFront request');
      const authorization = request.headers.authorization;
      const headers = new Headers();
      if(authorization?.length===1) headers.set('authorization',authorization[0].value);
      response = await handle(new Request('https://application.invalid/check-export',{method:request.method,headers}));
    } catch { response=unavailable(); }
    const headers: CloudFrontResultResponse['headers'] = {};
    response.headers.forEach((value,key)=>{headers[key]=[{key,value}];});
    return {status:String(response.status), headers, body:await response.text(), bodyEncoding:'text'};
  };
}
/** Publish a numbered Lambda version in us-east-1; $LATEST and aliases are unsupported. */
export const handler = createLambdaEdgeHandler(loadEdgeConfiguration);
