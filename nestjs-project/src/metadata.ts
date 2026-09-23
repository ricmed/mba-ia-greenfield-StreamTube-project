// Stub for @nestjs/swagger CLI plugin metadata.
// When using the TypeScript AST transformer (tsc path), the plugin injects
// __OPENAPI_METADATA_FACTORY__ methods directly into compiled DTO classes —
// no separate file is generated. This stub satisfies the import in main.ts.
//
// Generating the real file with PluginMetadataGenerator does NOT work in this
// project: it emits relative dynamic imports, and `moduleResolution: nodenext`
// rejects them without a `.js` extension while ts-node/ts-jest fail to resolve
// them *with* one (both forms raise ERR_MODULE_NOT_FOUND at runtime). That is
// why every DTO carries explicit @ApiProperty decorators: they are the only
// thing that survives the ts-node path used by `npm run openapi:export` and by
// the Jest suites.
export default (): Promise<Record<string, unknown>> => Promise.resolve({});
