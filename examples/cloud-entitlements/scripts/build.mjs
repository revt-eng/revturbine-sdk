import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
const entries = [
 ['providers/aws-lambda.ts','dist/aws/index.cjs',[]],
 ['providers/aws-lambda-edge.ts','dist/aws-edge/index.cjs',[]],
 ['providers/google-cloud-run.ts','dist/google-cloud-run/index.cjs',[]],
 ['providers/firebase.ts','dist/firebase/index.cjs',['firebase-functions','firebase-functions/*']],
 ['providers/azure-functions.ts','dist/azure/index.cjs',['@azure/functions']],
];
for(const [entry,outfile,external] of entries) {
 await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'cjs',target:'node22',external,logLevel:'warning'});
}
for(const provider of ['firebase','azure']) {
 await copyFile(`deploy/${provider}/package.json`,`dist/${provider}/package.json`);
}
await copyFile('deploy/azure/host.json','dist/azure/host.json');
await copyFile('deploy/firebase/firebase.json','dist/firebase/firebase.json');
await copyFile('deploy/google-cloud-run/Dockerfile','dist/google-cloud-run/Dockerfile');
// Compile the actual Vercel edge entry without allowing Node built-ins.
await build({entryPoints:['api/check-export.ts'],outfile:'dist/vercel-edge/check-export.js',bundle:true,
 platform:'browser',format:'esm',target:'es2022',minify:true,logLevel:'warning'});
console.log('Built Vercel Edge and five Node deployment artifacts.');
