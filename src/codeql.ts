import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as http from '@actions/http-client';
import { IHeaders } from '@actions/http-client/interfaces';
import * as toolcache from '@actions/tool-cache';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import * as stream from 'stream';
import * as globalutil from 'util';
import uuidV4 from 'uuid/v4';

import * as api from './api-client';
import * as defaults from './defaults.json'; // Referenced from codeql-action-sync-tool!
import { exec_wrapper } from './exec_wrapper';
import { Language } from './languages';
import * as util from './util';

type Options = (string|number|boolean)[];

/**
 * Extra command line options for the codeql commands.
 */
interface ExtraOptions {
  '*'?: Options;
  database?: {
    '*'?: Options,
    init?: Options,
    'trace-command'?: Options,
    analyze?: Options,
    finalize?: Options
  };
  resolve?: {
    '*'?: Options,
    extractor?: Options,
    queries?: Options
  };
}

export interface CodeQL {
  /**
   * Get the path of the CodeQL executable.
   */
  getPath(): string;
  /**
   * Print version information about CodeQL.
   */
  printVersion(): Promise<void>;
  /**
   * Run 'codeql database trace-command' on 'tracer-env.js' and parse
   * the result to get environment variables set by CodeQL.
   */
  getTracerEnv(databasePath: string, compilerSpec: string | undefined): Promise<{ [key: string]: string }>;
  /**
   * Run 'codeql database init'.
   */
  databaseInit(databasePath: string, language: Language, sourceRoot: string): Promise<void>;
  /**
   * Runs the autobuilder for the given language.
   */
  runAutobuild(language: Language): Promise<void>;
  /**
   * Extract code for a scanned language using 'codeql database trace-command'
   * and running the language extracter.
   */
  extractScannedLanguage(database: string, language: Language): Promise<void>;
  /**
   * Finalize a database using 'codeql database finalize'.
   */
  finalizeDatabase(databasePath: string): Promise<void>;
  /**
   * Run 'codeql resolve queries'.
   */
  resolveQueries(queries: string[], extraSearchPath: string | undefined): Promise<ResolveQueriesOutput>;
  /**
   * Run 'codeql database analyze'.
   */
  databaseAnalyze(databasePath: string, sarifFile: string, querySuite: string): Promise<void>;
}

export interface ResolveQueriesOutput {
  byLanguage: {
    [language: string]: {
      [queryPath: string]: {}
    }
  };
  noDeclaredLanguage: {
    [queryPath: string]: {}
  };
  multipleDeclaredLanguages: {
    [queryPath: string]: {}
  };
}

/**
 * Stores the CodeQL object, and is populated by `setupCodeQL` or `getCodeQL`.
 * Can be overridden in tests using `setCodeQL`.
 */
let cachedCodeQL: CodeQL | undefined = undefined;

const CODEQL_BUNDLE_VERSION = defaults.bundleVersion;
const CODEQL_BUNDLE_NAME = "codeql-bundle.tar.gz";
const CODEQL_DEFAULT_ACTION_REPOSITORY = "github/codeql-action";

function getCodeQLActionRepository(): string {
  // Actions do not know their own repository name,
  // so we currently use this hack to find the name based on where our files are.
  // This can be removed once the change to the runner in https://github.com/actions/runner/pull/585 is deployed.
  const runnerTemp = util.getRequiredEnvParam("RUNNER_TEMP");
  const actionsDirectory = path.join(path.dirname(runnerTemp), "_actions");
  const relativeScriptPath = path.relative(actionsDirectory, __filename);
  // This handles the case where the Action does not come from an Action repository,
  // e.g. our integration tests which use the Action code from the current checkout.
  if (relativeScriptPath.startsWith("..") || path.isAbsolute(relativeScriptPath)) {
    return CODEQL_DEFAULT_ACTION_REPOSITORY;
  }
  const relativeScriptPathParts = relativeScriptPath.split(path.sep);
  return relativeScriptPathParts[0] + "/" + relativeScriptPathParts[1];
}

async function getCodeQLBundleDownloadURL(): Promise<string> {
  const codeQLActionRepository = getCodeQLActionRepository();
  const potentialDownloadSources = [
    // This GitHub instance, and this Action.
    [util.getInstanceAPIURL(), codeQLActionRepository],
    // This GitHub instance, and the canonical Action.
    [util.getInstanceAPIURL(), CODEQL_DEFAULT_ACTION_REPOSITORY],
    // GitHub.com, and the canonical Action.
    [util.GITHUB_DOTCOM_API_URL, CODEQL_DEFAULT_ACTION_REPOSITORY],
  ];
  // We now filter out any duplicates.
  // Duplicates will happen either because the GitHub instance is GitHub.com, or because the Action is not a fork.
  const uniqueDownloadSources = potentialDownloadSources.filter((url, index, self) => index === self.indexOf(url));
  for (let downloadSource of uniqueDownloadSources) {
    let [apiURL, repository] = downloadSource;
    // If we've reached the final case, short-circuit the API check since we know the bundle exists and is public.
    if (apiURL === util.GITHUB_DOTCOM_API_URL && repository === CODEQL_DEFAULT_ACTION_REPOSITORY) {
      break;
    }
    let [repositoryOwner, repositoryName] = repository.split("/");
    try {
      const release = await api.getActionsApiClient().repos.getReleaseByTag({
        owner: repositoryOwner,
        repo: repositoryName,
        tag: CODEQL_BUNDLE_VERSION
      });
      for (let asset of release.data.assets) {
        if (asset.name === CODEQL_BUNDLE_NAME) {
          core.info(`Found CodeQL bundle in ${downloadSource[1]} on ${downloadSource[0]} with URL ${asset.url}.`);
          return asset.url;
        }
      }
    } catch (e) {
      core.info(`Looked for CodeQL bundle in ${downloadSource[1]} on ${downloadSource[0]} but got error ${e}.`);
    }
  }
  return `https://github.com/${CODEQL_DEFAULT_ACTION_REPOSITORY}/releases/download/${CODEQL_BUNDLE_VERSION}/${CODEQL_BUNDLE_NAME}`;
}

// We have to download CodeQL manually because the toolcache doesn't support Accept headers.
// This can be removed once https://github.com/actions/toolkit/pull/530 is merged and released.
async function toolcacheDownloadTool(url: string, headers?: IHeaders): Promise<string> {
  const client = new http.HttpClient('CodeQL Action');
  const dest = path.join(util.getRequiredEnvParam('RUNNER_TEMP'), uuidV4());
  const response: http.HttpClientResponse = await client.get(url, headers);
  if (response.message.statusCode !== 200) {
    const err = new toolcache.HTTPError(response.message.statusCode);
    core.info(
      `Failed to download from "${url}". Code(${response.message.statusCode}) Message(${response.message.statusMessage})`
    );
    throw err;
  }
  const pipeline = globalutil.promisify(stream.pipeline);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(response.message, fs.createWriteStream(dest));
  return dest;
}

export async function setupCodeQL(): Promise<CodeQL> {
  try {
    let codeqlURL = core.getInput('tools');
    const codeqlURLVersion = getCodeQLURLVersion(codeqlURL || `/${CODEQL_BUNDLE_VERSION}/`);

    let codeqlFolder = toolcache.find('CodeQL', codeqlURLVersion);
    if (codeqlFolder) {
      core.debug(`CodeQL found in cache ${codeqlFolder}`);
    } else {
      if (!codeqlURL) {
        codeqlURL = await getCodeQLBundleDownloadURL();
      }

      const headers: IHeaders = {accept: 'application/octet-stream'};
      // We only want to provide an authorization header if we are downloading
      // from the same GitHub instance the Action is running on.
      // This avoids leaking Enterprise tokens to dotcom.
      if (codeqlURL.startsWith(util.getInstanceAPIURL() + "/")) {
        core.debug('Downloading CodeQL bundle with token.');
        let token = core.getInput('token', { required: true });
        headers.authorization = `token ${token}`;
      } else {
        core.debug('Downloading CodeQL bundle without token.');
      }
      let codeqlPath = await toolcacheDownloadTool(codeqlURL, headers);
      core.debug(`CodeQL bundle download to ${codeqlPath} complete.`);

      const codeqlExtracted = await toolcache.extractTar(codeqlPath);
      codeqlFolder = await toolcache.cacheDir(codeqlExtracted, 'CodeQL', codeqlURLVersion);
    }

    let codeqlCmd = path.join(codeqlFolder, 'codeql', 'codeql');
    if (process.platform === 'win32') {
      codeqlCmd += ".exe";
    } else if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error("Unsupported platform: " + process.platform);
    }

    cachedCodeQL = getCodeQLForCmd(codeqlCmd);
    return cachedCodeQL;

  } catch (e) {
    core.error(e);
    throw new Error("Unable to download and extract CodeQL CLI");
  }
}

export function getCodeQLURLVersion(url: string): string {

  const match = url.match(/\/codeql-bundle-(.*)\//);
  if (match === null || match.length < 2) {
    throw new Error(`Malformed tools url: ${url}. Version could not be inferred`);
  }

  let version = match[1];

  if (!semver.valid(version)) {
    core.debug(`Bundle version ${version} is not in SemVer format. Will treat it as pre-release 0.0.0-${version}.`);
    version = '0.0.0-' + version;
  }

  const s = semver.clean(version);
  if (!s) {
    throw new Error(`Malformed tools url ${url}. Version should be in SemVer format but have ${version} instead`);
  }

  return s;
}

/**
 * Use the CodeQL executable located at the given path.
 */
export function getCodeQL(cmd: string): CodeQL {
  if (cachedCodeQL === undefined) {
    cachedCodeQL = getCodeQLForCmd(cmd);
  }
  return cachedCodeQL;
}

function resolveFunction<T>(
  partialCodeql: Partial<CodeQL>,
  methodName: string,
  defaultImplementation?: T): T {
  if (typeof partialCodeql[methodName] !== 'function') {
    if (defaultImplementation !== undefined) {
      return defaultImplementation;
    }
    const dummyMethod = () => {
      throw new Error('CodeQL ' + methodName + ' method not correctly defined');
    };
    return dummyMethod as any;
  }
  return partialCodeql[methodName];
}

/**
 * Set the functionality for CodeQL methods. Only for use in tests.
 *
 * Accepts a partial object and any undefined methods will be implemented
 * to immediately throw an exception indicating which method is missing.
 */
export function setCodeQL(partialCodeql: Partial<CodeQL>): CodeQL {
  cachedCodeQL = {
    getPath: resolveFunction(partialCodeql, 'getPath', () => '/tmp/dummy-path'),
    printVersion: resolveFunction(partialCodeql, 'printVersion'),
    getTracerEnv: resolveFunction(partialCodeql, 'getTracerEnv'),
    databaseInit: resolveFunction(partialCodeql, 'databaseInit'),
    runAutobuild: resolveFunction(partialCodeql, 'runAutobuild'),
    extractScannedLanguage: resolveFunction(partialCodeql, 'extractScannedLanguage'),
    finalizeDatabase: resolveFunction(partialCodeql, 'finalizeDatabase'),
    resolveQueries: resolveFunction(partialCodeql, 'resolveQueries'),
    databaseAnalyze: resolveFunction(partialCodeql, 'databaseAnalyze')
  };
  return cachedCodeQL;
}

/**
 * Get the cached CodeQL object. Should only be used from tests.
 *
 * TODO: Work out a good way for tests to get this from the test context
 * instead of having to have this method.
 */
export function getCachedCodeQL(): CodeQL {
  if (cachedCodeQL === undefined) {
    // Should never happen as setCodeQL is called by testing-utils.setupTests
    throw new Error('cachedCodeQL undefined');
  }
  return cachedCodeQL;
}

function getCodeQLForCmd(cmd: string): CodeQL {
  return {
    getPath: function() {
      return cmd;
    },
    printVersion: async function() {
      await exec.exec(cmd, [
        'version',
        '--format=json'
      ]);
    },
    getTracerEnv: async function(databasePath: string, compilerSpec: string | undefined) {
      let envFile = path.resolve(databasePath, 'working', 'env.tmp');
      const compilerSpecArg = compilerSpec ? ["--compiler-spec=" + compilerSpec] : [];
      await exec.exec(cmd, [
        'database',
        'trace-command',
        databasePath,
        ...compilerSpecArg,
        ...getExtraOptionsFromEnv(['database', 'trace-command']),
        process.execPath,
        path.resolve(__dirname, 'tracer-env.js'),
        envFile
      ]);
      return JSON.parse(fs.readFileSync(envFile, 'utf-8'));
    },
    databaseInit: async function(databasePath: string, language: Language, sourceRoot: string) {
      await exec.exec(cmd, [
        'database',
        'init',
        databasePath,
        '--language=' + language,
        '--source-root=' + sourceRoot,
        ...getExtraOptionsFromEnv(['database', 'init']),
      ]);
    },
    runAutobuild: async function(language: Language) {
      const cmdName = process.platform === 'win32' ? 'autobuild.cmd' : 'autobuild.sh';
      const autobuildCmd = path.join(path.dirname(cmd), language, 'tools', cmdName);

      // Update JAVA_TOOL_OPTIONS to contain '-Dhttp.keepAlive=false'
      // This is because of an issue with Azure pipelines timing out connections after 4 minutes
      // and Maven not properly handling closed connections
      // Otherwise long build processes will timeout when pulling down Java packages
      // https://developercommunity.visualstudio.com/content/problem/292284/maven-hosted-agent-connection-timeout.html
      let javaToolOptions = process.env['JAVA_TOOL_OPTIONS'] || "";
      process.env['JAVA_TOOL_OPTIONS'] = [...javaToolOptions.split(/\s+/), '-Dhttp.keepAlive=false', '-Dmaven.wagon.http.pool=false'].join(' ');

      await exec.exec(autobuildCmd);
    },
    extractScannedLanguage: async function(databasePath: string, language: Language) {
      // Get extractor location
      let extractorPath = '';
      await exec_wrapper(
        cmd,
        [
          'resolve',
          'extractor',
          '--format=json',
          '--language=' + language,
          ...getExtraOptionsFromEnv(['resolve', 'extractor']),
        ],
        [[0, new RegExp("(No source code was seen during the build\\.|No JavaScript or TypeScript code found\\.)"), 'foo bar']],
        {
          silent: true,
          listeners: {
            stdout: (data) => { extractorPath += data.toString(); },
            stderr: (data) => { process.stderr.write(data); }
          }
        });

      // Set trace command
      const ext = process.platform === 'win32' ? '.cmd' : '.sh';
      const traceCommand = path.resolve(JSON.parse(extractorPath), 'tools', 'autobuild' + ext);

      // Run trace command
      await exec_wrapper(
        cmd, [
          'database',
          'trace-command',
          ...getExtraOptionsFromEnv(['database', 'trace-command']),
          databasePath,
          '--',
          traceCommand
        ],
        [[0, new RegExp("(No source code was seen during the build\\.|No JavaScript or TypeScript code found\\.)"), 'foo bar']]
      );
    },
    finalizeDatabase: async function(databasePath: string) {
      await exec_wrapper(
        cmd, [
          'database',
          'finalize',
          ...getExtraOptionsFromEnv(['database', 'finalize']),
          databasePath
        ],
        [[0, new RegExp("(No source code was seen during the build\\.|No JavaScript or TypeScript code found\\.)"), 'foo bar']]);
    },
    resolveQueries: async function(queries: string[], extraSearchPath: string | undefined) {
      const codeqlArgs = [
        'resolve',
        'queries',
        ...queries,
        '--format=bylanguage',
        ...getExtraOptionsFromEnv(['resolve', 'queries'])
      ];
      if (extraSearchPath !== undefined) {
        codeqlArgs.push('--search-path', extraSearchPath);
      }
      let output = '';
      await exec.exec(cmd, codeqlArgs, {
        listeners: {
          stdout: (data: Buffer) => {
            output += data.toString();
          }
        }
      });

      return JSON.parse(output);
    },
    databaseAnalyze: async function(databasePath: string, sarifFile: string, querySuite: string) {
      await exec.exec(cmd, [
        'database',
        'analyze',
        util.getMemoryFlag(),
        util.getThreadsFlag(),
        databasePath,
        '--format=sarif-latest',
        '--output=' + sarifFile,
        '--no-sarif-add-snippets',
        ...getExtraOptionsFromEnv(['database', 'analyze']),
        querySuite
      ]);
    }
  };
}

/**
 * Gets the options for `path` of `options` as an array of extra option strings.
 */
function getExtraOptionsFromEnv(path: string[]) {
  let options: ExtraOptions = util.getExtraOptionsEnvParam();
  return getExtraOptions(options, path, []);
}

/**
 * Gets the options for `path` of `options` as an array of extra option strings.
 *
 * - the special terminal step name '*' in `options` matches all path steps
 * - throws an exception if this conversion is impossible.
 */
export /* exported for testing */ function getExtraOptions(
  options: any,
  path: string[],
  pathInfo: string[]): string[] {
  /**
   * Gets `options` as an array of extra option strings.
   *
   * - throws an exception mentioning `pathInfo` if this conversion is impossible.
   */
  function asExtraOptions(options: any, pathInfo: string[]): string[] {
    if (options === undefined) {
      return [];
    }
    if (!Array.isArray(options)) {
      const msg =
        `The extra options for '${pathInfo.join('.')}' ('${JSON.stringify(options)}') are not in an array.`;
      throw new Error(msg);
    }
    return options.map(o => {
      const t = typeof o;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        const msg =
          `The extra option for '${pathInfo.join('.')}' ('${JSON.stringify(o)}') is not a primitive value.`;
        throw new Error(msg);
      }
      return o + '';
    });
  }
  let all = asExtraOptions(options?.['*'], pathInfo.concat('*'));
  let specific = path.length === 0 ?
    asExtraOptions(options, pathInfo) :
    getExtraOptions(options?.[path[0]], path?.slice(1), pathInfo.concat(path[0]));
  return all.concat(specific);
}
