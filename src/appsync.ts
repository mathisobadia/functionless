import * as appsync from "@aws-cdk/aws-appsync-alpha";
import { AppSyncResolverEvent } from "aws-lambda";
import { CanReference, CallExpr, Expr } from "./expression";
import { VTL } from "./vtl";
import { findService, toName } from "./util";
import {
  ToAttributeMap,
  ToAttributeValue,
} from "typesafe-dynamodb/lib/attribute-value";
import { FunctionDecl, isFunctionDecl } from "./declaration";
import { Literal } from "./literal";
import { aws_stepfunctions } from "aws-cdk-lib";
import { Construct } from "constructs";
import { isErr } from "./error";
import { isTable } from "./table";
import { isFunction } from "./function";
import { isStepFunction } from "./step-function";

/**
 * The shape of the AWS Appsync `$context` variable.
 *
 * Both the `arguments` and `stash` fields are purposely omitted since they are used internally
 * by the TypeScript->VTL conversion logic.
 *
 * @see https://docs.aws.amazon.com/appsync/latest/devguide/resolver-context-reference.html
 */
export interface AppsyncContext<
  Arguments extends ResolverArguments,
  Source = undefined
> extends Omit<AppSyncResolverEvent<never, Source>, "arguments" | "stash"> {
  arguments: Arguments;
}

/**
 * The shape of an AWS Appsync Resolver's `$context.arguments`.
 *
 * The values must be of type {@link Literal} and cannot be arbitrary JavaScript types since
 * they must be receivable in a GraphQL request.
 */
export interface ResolverArguments {
  [key: string]: Literal;
}

/**
 * A {@link ResolverFunction} is a function that represents an AWS Appsync Resolver Pipeline.
 *
 * @tparam Arguments - an object describing the shape of `$context.arguments`.
 * @tparam Result - the type of data returned by the Resolver.
 * @tparam Source - the parent type of the Appsync Resolver.
 */
export type ResolverFunction<
  Arguments extends ResolverArguments,
  Result,
  Source
> = ($context: AppsyncContext<Arguments, Source>) => Result;

export interface SynthesizedAppsyncResolverProps extends appsync.ResolverProps {
  readonly templates: string[];
}

/**
 * An {@link appsync.Resolver} synthesized by a {@link AppsyncResolver}.
 */
export class SynthesizedAppsyncResolver extends appsync.Resolver {
  /**
   * All of the Request and Response Mapping templates in the order they are executed by the AppSync service.
   */
  readonly templates: string[];

  constructor(
    scope: Construct,
    id: string,
    props: SynthesizedAppsyncResolverProps
  ) {
    super(scope, id, props);
    this.templates = props.templates;
  }
}

/**
 * An AWS AppSync Resolver Function derived from TypeScript syntax.
 *
 * First, you must wrap a CDK L2 Construct in the corresponding Functionless type-safe interfaces.
 * ```ts
 * const table = new Table<Person, "id">(new aws_dynamodb.Table(scope, "id", props));
 * ```
 *
 * Then, call the table from within the new AppsyncResolver:
 * ```ts
 * const getPerson = new AppsyncResolver<{id: string}, Person | undefined>(
 *   ($context, id) => {
 *     const person = table.get({
 *       key: {
 *         id: $util.toDynamoDB(id)
 *       }
 *     });
 *     return person;
 *   });
 * ```
 *
 * Finally, the `getPerson` function can be used to create resolvers on a GraphQL API
 * ```ts
 * import * as appsync from "@aws-cdk/aws-appsync-alpha";
 *
 * const api = new appsync.GraphQLApi(..);
 *
 * getPerson.createResolver(api, {
 *   typeName: "Query",
 *   fieldName: "getPerson"
 * });
 * ```
 *
 * @functionless AppsyncFunction
 */
export class AppsyncResolver<
  Arguments extends ResolverArguments,
  Result,
  Source = undefined
> {
  /**
   * This static property identifies this class as an AppsyncResolver to the TypeScript plugin.
   */
  public static readonly FunctionlessType = "AppsyncResolver";

  public readonly decl: FunctionDecl<
    ResolverFunction<Arguments, Result, Source>
  >;

  constructor(fn: ResolverFunction<Arguments, Result, Source>) {
    if (isFunctionDecl(fn)) {
      this.decl = fn;
    } else if (isErr(fn)) {
      throw fn.error;
    } else {
      throw Error("Unknown compiler error.");
    }
  }

  /**
   * Generate and add an AWS Appsync Resolver to an AWS Appsync GraphQL API.
   *
   * ```ts
   * import * as appsync from "@aws-cdk/aws-appsync-alpha";
   *
   * const api = new appsync.GraphQLApi(..);
   *
   * getPerson.createResolver(api, {
   *   typeName: "Query",
   *   fieldName: "getPerson"
   * });
   * ```
   *
   * @param api the AWS Appsync API to add this Resolver to
   * @param options typeName, fieldName and cachingConfig for this Resolver.
   * @returns a reference to the generated {@link appsync.Resolver}.
   */
  public addResolver(
    api: appsync.GraphqlApi,
    options: Pick<
      appsync.BaseResolverProps,
      "typeName" | "fieldName" | "cachingConfig"
    >
  ): SynthesizedAppsyncResolver {
    const resolverCount = countResolvers(this.decl);
    const templates: string[] = [];

    if (resolverCount === 0) {
      // mock integration
      const [pipelineConfig, responseMappingTemplate] = synthesizeFunctions(
        this.decl
      );

      if (pipelineConfig.length !== 0) {
        throw new Error(
          `expected 0 functions in pipelineConfig, but found ${pipelineConfig.length}`
        );
      }

      const requestMappingTemplate = `{
  "version": "2018-05-29",
  "payload": null
}`;
      templates.push(requestMappingTemplate);

      const resolver = new SynthesizedAppsyncResolver(
        api,
        `${options.typeName}${options.fieldName}Resolver`,
        {
          ...options,
          api,
          templates,
          dataSource: getDataSource(
            api,
            null,
            () =>
              new appsync.NoneDataSource(api, "None", {
                api,
                name: "None",
              })
          ),
          requestMappingTemplate: appsync.MappingTemplate.fromString(
            requestMappingTemplate
          ),
          responseMappingTemplate: appsync.MappingTemplate.fromString(
            responseMappingTemplate
          ),
        }
      );

      templates.push(responseMappingTemplate);
      return resolver;
      // } else if (resolverCount === 1) {
      // single stage
    } else {
      // pipeline resolver
      const requestMappingTemplate = "{}";
      templates.push(requestMappingTemplate);

      const [pipelineConfig, responseMappingTemplate] = synthesizeFunctions(
        this.decl
      );

      const resolver = new SynthesizedAppsyncResolver(
        api,
        `${options.typeName}${options.fieldName}Resolver`,
        {
          ...options,
          api,
          templates,
          pipelineConfig,
          requestMappingTemplate: appsync.MappingTemplate.fromString(
            requestMappingTemplate
          ),
          responseMappingTemplate: appsync.MappingTemplate.fromString(
            responseMappingTemplate
          ),
        }
      );
      templates.push(responseMappingTemplate);

      return resolver;
    }

    function synthesizeFunctions(
      decl: FunctionDecl<ResolverFunction<Arguments, Result, Source>>
    ) {
      let template =
        resolverCount === 0 ? new VTL() : new VTL(VTL.CircuitBreaker);
      const functions = decl.body.statements
        .map((stmt, i) => {
          const isLastExpr = i + 1 === decl.body.statements.length;
          const service = findService(stmt);
          if (service) {
            // we must now render a resolver with request mapping template
            const dataSource = getDataSource(api, service, () => {
              if (isTable(service)) {
                return new appsync.DynamoDbDataSource(
                  api,
                  service.resource.node.addr,
                  {
                    api,
                    table: service.resource,
                  }
                );
              } else if (isFunction(service)) {
                return new appsync.LambdaDataSource(
                  api,
                  service.resource.node.addr,
                  {
                    api,
                    lambdaFunction: service.resource,
                  }
                );
              } else if (isStepFunction(service)) {
                const ds = new appsync.HttpDataSource(
                  api,
                  service.resource.node.addr,
                  {
                    api,
                    endpoint: `https://${
                      service.getStepFunctionType() ===
                      aws_stepfunctions.StateMachineType.EXPRESS
                        ? "sync-states"
                        : "states"
                    }.${service.resource.stack.region}.amazonaws.com/`,
                    authorizationConfig: {
                      signingRegion: api.stack.region,
                      signingServiceName: "states",
                    },
                  }
                );
                service.grantRead(ds.grantPrincipal);
                if (
                  service.getStepFunctionType() ===
                  aws_stepfunctions.StateMachineType.EXPRESS
                ) {
                  service.grantStartSyncExecution(ds.grantPrincipal);
                } else {
                  service.grantStartExecution(ds.grantPrincipal);
                }
                return ds;
              } else {
                // TODO: use HTTP resolvers for the AWS-SDK types.
                throw new Error(
                  `Reference cannot be used within an Appsync Resolver, please use an Appsync-compatible function`
                );
              }
            });

            let returnValName = "$context.result";
            let pre: string | undefined;
            if (isStepFunction(service)) {
              returnValName = "$sfn__result";

              if (
                service.getStepFunctionType() ===
                aws_stepfunctions.StateMachineType.EXPRESS
              ) {
                pre = `#if($context.result.statusCode == 200)
  #set(${returnValName} = $util.parseJson($context.result.body))
  #if(${returnValName}.output == 'null')
    $util.qr(${returnValName}.put("output", $null))
  #else
    #set(${returnValName}.output = $util.parseJson(${returnValName}.output))
  #end
#else 
  $util.error($context.result.body, "$context.result.statusCode")
#end`;
              } else {
                pre = `#if($context.result.statusCode == 200)
  #set(${returnValName} = $util.parseJson($context.result.body))
#else 
  $util.error($context.result.body, "$context.result.statusCode")
#end`;
              }
            }

            if (stmt.kind === "ExprStmt") {
              const call = findServiceCallExpr(stmt.expr);
              template.call(call);
              return createStage(call, "{}");
            } else if (stmt.kind === "ReturnStmt") {
              return createStage(
                findServiceCallExpr(stmt.expr),
                `${
                  pre ? `${pre}\n` : ""
                }#set( $context.stash.return__flag = true )
#set( $context.stash.return__val = ${getResult(stmt.expr)} )
{}`
              );
            } else if (
              stmt.kind === "VariableStmt" &&
              stmt.expr?.kind === "CallExpr"
            ) {
              return createStage(
                findServiceCallExpr(stmt.expr),
                `${pre ? `${pre}\n` : ""}#set( $context.stash.${
                  stmt.name
                } = ${getResult(stmt.expr)} )\n{}`
              );
            } else {
              throw new Error(
                `only a 'VariableDecl', 'Call' or 'Return' expression may call a service`
              );
            }

            /**
             * Recursively resolve the {@link expr} to the {@link CallExpr} that is calling the service.
             *
             * @param expr an Expression that contains (somewhere nested within) a {@link CallExpr} to an external service.
             * @returns the {@link CallExpr} that
             */
            function findServiceCallExpr(expr: Expr): CallExpr {
              if (
                expr.kind === "CallExpr" &&
                (expr.expr.kind === "ReferenceExpr" ||
                  (expr.expr.kind === "PropAccessExpr" &&
                    expr.expr.expr.kind === "ReferenceExpr"))
              ) {
                // this catches specific cases:
                // lambdaFunction()
                // table.get()
                // table.<method-name>()

                // all other Calls or PropAccessExpr are considered "after" the service call, e.g.
                // lambdaFunction().prop
                // table.query().Items.size() //.size() is still a Call but not a call to a service.
                return expr;
              } else if (expr.kind === "PropAccessExpr") {
                return findServiceCallExpr(expr.expr);
              } else if (expr.kind === "CallExpr") {
                return findServiceCallExpr(expr.expr);
              } else {
                throw new Error(``);
              }
            }

            /**
             * Resolve a VTL expression that applies in-line expressions such as PropAccessExpr to
             * the result from `$context.result` in a Response Mapping template.
             *
             * Example:
             * ```ts
             * const items = table.query().items
             * ```
             *
             * The Response Mapping Template will include:
             * ```
             * #set($context.stash.items = $context.result.items)
             * ```
             *
             * @param expr the {@link Expr} which is triggering a call to an external service, such as a Table or Function.
             * @returns a VTL expression to be included in the Response Mapping Template to extract the contents from `$context.result`.
             */
            function getResult(expr: Expr): string {
              if (expr.kind === "CallExpr") {
                template.call(expr);
                return returnValName;
              } else if (expr.kind === "PropAccessExpr") {
                return `${getResult(expr.expr)}.${expr.name}`;
              } else if (expr.kind === "ElementAccessExpr") {
                return `${getResult(expr.expr)}[${getResult(expr.element)}]`;
              } else {
                throw new Error(
                  `invalid Expression in-lined with Service Call: ${expr.kind}`
                );
              }
            }

            function createStage(
              expr: CallExpr,
              responseMappingTemplate: string
            ) {
              const requestMappingTemplateString = template.toVTL();
              templates.push(requestMappingTemplateString);
              templates.push(responseMappingTemplate);
              template = new VTL(VTL.CircuitBreaker);
              const name = getUniqueName(api, toName(expr.expr));
              return dataSource.createFunction({
                name,
                requestMappingTemplate: appsync.MappingTemplate.fromString(
                  requestMappingTemplateString
                ),
                responseMappingTemplate: appsync.MappingTemplate.fromString(
                  responseMappingTemplate
                ),
              });
            }
          } else if (isLastExpr) {
            if (stmt.kind === "ReturnStmt") {
              template.return(stmt.expr);
            } else if (stmt.kind === "IfStmt") {
              template.eval(stmt);
            } else {
              template.return("$null");
            }
          } else {
            // this expression should be appended to the current mapping template
            template.eval(stmt);
          }

          return undefined;
        })
        .filter(
          (func): func is Exclude<typeof func, undefined> => func !== undefined
        );

      return [functions, template.toVTL()] as const;
    }

    function countResolvers(
      decl: FunctionDecl<ResolverFunction<Arguments, Result, Source>>
    ): number {
      return decl.body.statements.filter(
        (expr) => findService(expr) !== undefined
      ).length;
    }
  }
}

/**
 * A reference to the AWS Appsync `$util` variable globally available to all Resolvers.
 *
 * Use the functions on `$util` to perform computations within an {@link AppsyncResolver}. They
 * will be translated directly to calls within the Velocity Template Engine.
 *
 * @see https://docs.aws.amazon.com/appsync/latest/devguide/resolver-util-reference.html
 */
export declare const $util: $util;

/**
 * $util.dynamodb contains helper methods that make it easier to write and read data to Amazon DynamoDB, such as automatic type mapping and formatting. These methods are designed to make mapping primitive types and Lists to the proper DynamoDB input format automatically, which is a Map of the format { "TYPE" : VALUE }.
 *
 * @see https://docs.aws.amazon.com/appsync/latest/devguide/resolver-util-reference.html#dynamodb-helpers-in-util-dynamodb
 */
export interface dynamodb {
  /**
   * General object conversion tool for DynamoDB that converts input objects to the appropriate DynamoDB representation. It's opinionated about how it represents some types: e.g., it will use lists ("L") rather than sets ("SS", "NS", "BS"). This returns an object that describes the DynamoDB attribute value.
   *
   * @param value a JSON value to convert {@link ToAttributeValue}.
   * @see https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeValue.html
   */
  toDynamoDB<T>(value: T): ToAttributeValue<T>;
  /**
   * Creates a copy of the map where each value has been converted to its appropriate DynamoDB format. It's opinionated about how it represents some of the nested objects: e.g., it will use lists ("L") rather than sets ("SS", "NS", "BS").
   * @param value an object to convert {@link ToAttributeMap}
   */
  toMapValues<T extends object>(value: T): ToAttributeMap<T>;
}

/**
 * @see https://docs.aws.amazon.com/appsync/latest/devguide/resolver-util-reference.html
 */
export interface $util {
  /**
   * $util.dynamodb contains helper methods that make it easier to write and read data to Amazon DynamoDB, such as automatic type mapping and formatting. These methods are designed to make mapping primitive types and Lists to the proper DynamoDB input format automatically, which is a Map of the format { "TYPE" : VALUE }.
   *
   * @see https://docs.aws.amazon.com/appsync/latest/devguide/resolver-util-reference.html#dynamodb-helpers-in-util-dynamodb
   */
  readonly dynamodb: dynamodb;

  /**
   * The $util.time variable contains datetime methods to help generate timestamps, convert between datetime formats, and parse datetime strings. The syntax for datetime formats is based on DateTimeFormatter which you can reference for further documentation. Below we provide some examples, as well as a list of available methods and descriptions.
   *
   * @see https://docs.aws.amazon.com/appsync/latest/devguide/time-helpers-in-util-time.html
   */
  readonly time: time;

  /**
   * Returns the input string as a JavaScript escaped string.
   */
  escapeJavaScript(js: string): string;

  /**
   * Returns the input string as an application/x-www-form-urlencoded encoded string.
   */
  urlEncode(string: string): string;

  /**
   * Decodes an application/x-www-form-urlencoded encoded string back to its non-encoded form.
   */
  urlDecode(string: string): string;

  /**
   * Encodes the input into a base64-encoded string.
   */
  base64Encode(data: Buffer): string;

  /**
   * Decodes the data from a base64-encoded string.
   */
  base64Decode(string: string): Buffer;

  /**
   * Takes "stringified" JSON and returns an object representation of the result.
   */
  parseJson(string: string): object;

  /**
   * Takes an object and returns a "stringified" JSON representation of that object.
   */
  toJson(obj: object): string;

  /**
   * Returns a 128-bit randomly generated UUID.
   */
  autoId(): string;

  /**
   * Returns a 128-bit randomly generated ULID (Universally Unique Lexicographically Sortable Identifier).
   */
  autoUlid(): string;

  /**
   * Throws Unauthorized for the field being resolved. Use this in request or response mapping templates to determine whether to allow the caller to resolve the field.
   */
  unauthorized(): never;

  /**
   * Throws a custom error. Use this in request or response mapping templates to detect an error with the request or with the invocation result.
   */
  error(errorMessage: string): never;

  /**
   * Throws a custom error. Use this in request or response mapping templates to detect an error with the request or with the invocation result. You can also specify an errorType.
   */
  error(errorMessage: string, errorType: string): never;

  /**
   * Throws a custom error. Use this in request or response mapping templates to detect an error with the request or with the invocation result. You can also specify an errorType and a data field. The data value will be added to the corresponding error block inside errors in the GraphQL response. Note: data will be filtered based on the query selection set.
   */
  error(errorMessage: string, errorType: string, errorData: object): never;

  /**
   * Throws a custom error. This can be used in request or response mapping templates if the template detects an error with the request or with the invocation result. Additionally, an errorType field, a data field, and a errorInfo field can be specified. The data value will be added to the corresponding error block inside errors in the GraphQL response. Note: data will be filtered based on the query selection set. The errorInfo value will be added to the corresponding error block inside errors in the GraphQL response. Note: errorInfo will NOT be filtered based on the query selection set.
   */
  error(
    errorMessage: string,
    errorType: string,
    errorData: object,
    errorInfo: object
  ): never;
  /**
   * Appends a custom error. This can be used in request or response mapping templates if the template detects an error with the request or with the invocation result. Unlike error(string: string), the template evaluation will not be interrupted, so that data can be returned to the caller./**
   */

  appendError(message: string): void;

  /**
   * Appends a custom error. This can be used in request or response mapping templates if the template detects an error with the request or with the invocation result. Additionally, an errorType can be specified. Unlike error(string, string), the template evaluation will not be interrupted, so that data can be returned to the caller./**
   */
  appendError(message: string, errorType: string): void;

  /**
   * Appends a custom error. This can be used in request or response mapping templates if the template detects an error with the request or with the invocation result. Additionally, an errorType and a data field can be specified. Unlike error(string, string, object), the template evaluation will not be interrupted, so that data can be returned to the caller. The data value will be added to the corresponding error block inside errors in the GraphQL response. Note: data will be filtered based on the query selection set./**
   */
  appendError(message: string, errorType: string, data: object): void;

  /**
   *
   */
  appendError(
    message: string,
    errorType: string,
    data: object,
    errorInfo: object
  ): void;

  /**
   * If the condition is false, throw a CustomTemplateException with the specified message.
   */
  validate(condition: boolean, message: string): never;

  /**
   * If the condition is false, throw a CustomTemplateException with the specified message and error type.
   */
  validate(condition: boolean, message: string, data: object): void;

  /**
   * If the condition is false, throw a CustomTemplateException with the specified message and error type, as well as data to return in the response.
   */
  validate(
    condition: boolean,
    message: string,
    data: object,
    info: object
  ): void;

  /**
   * Returns true if the supplied object is null.
   */
  isNull(obj: object): boolean;

  /**
   * Returns true if the supplied data is null or an empty string. Otherwise, returns false.
   */
  isNullOrEmpty(string: string): boolean;

  /**
   * Returns true if the supplied data is null or a blank string. Otherwise, returns false.
   */
  isNullOrBlank(string: string): boolean;

  /**
   * Returns the first object if it is not null. Otherwise, returns second object as a "default object".
   */
  defaultIfNull<T>(maybeVal: T | undefined | null, ifNull: T): T;

  /**
   * Returns the first string if it is not null or empty. Otherwise, returns second string as a "default string".
   */
  defaultIfNullOrEmpty<MaybeStr extends string, Default extends string>(
    maybeStr: MaybeStr | undefined,
    defaultVal: Default
  ): MaybeStr extends undefined | "" ? Default : MaybeStr;

  /**
   * Returns the first string if it is not null or blank. Otherwise, returns second string as a "default string".
   */
  defaultIfNullOrBlank<MaybeStr extends string, Default extends string>(
    maybeStr: MaybeStr | undefined,
    defaultVal: Default
  ): MaybeStr extends undefined | "" ? Default : MaybeStr;

  /**
   * Returns true if object is a string.
   */
  isString(obj: any): obj is string;

  /**
   * Returns true if object is a Number.
   */
  isNumber(obj: any): obj is number;

  /**
   * Returns true if object is a Boolean.
   */
  isBoolean(obj: any): obj is boolean;

  /**
   * Returns true if object is a List.
   */
  isList(obj: any): obj is any[];

  /**
   * Returns true if object is a Map.
   */
  isMap(obj: any): obj is Record<string, any>;

  /**
   * Returns a string describing the type of the object. Supported type identifications are: "Null", "Number", "string", "Map", "List", "Boolean". If a type cannot be identified, the return type is "object".
   */
  typeOf(obj: object): string;
  /**
   * Returns true if the specified pattern in the first argument matches the supplied data in the second argument. The pattern must be a regular expression such as matches("a*b", "aaaaab"). The functionality is based on Pattern, which you can reference for further documentation./**
   */
  matches(pattern: string, data: string): boolean;
  /**
   * Returns a string describing the multi-auth type being used by a request, returning back either "IAM Authorization", "User Pool Authorization", "Open ID Connect Authorization", or "API Key Authorization".
   */
  authType(): string;
}

export interface time {
  /**
   * Returns a String representation of UTC in ISO8601 format.
   */
  nowISO8601(): string;

  /**
   * Returns the number of seconds from the epoch of 1970-01-01T00:00:00Z to now.
   */
  nowEpochSeconds(): number;

  /**
   * Returns the number of milliseconds from the epoch of 1970-01-01T00:00:00Z to now.
   */
  nowEpochMilliSeconds(): number;

  /**
   * Returns a string of the current timestamp in UTC using the specified format from a String input type.
   */
  nowFormatted(format: string): string;

  /**
   * Returns a string of the current timestamp for a timezone using the specified format and timezone from String input types.
   */
  nowFormatted(format: string, timezone: string): string;

  /**
   * Parses a timestamp passed as a String, along with a format, and return the timestamp as milliseconds since epoch.
   */
  parseFormattedToEpochMilliSeconds(timestamp: string, format: string): number;

  /**
   * Parses a timestamp passed as a String, along with a format and time zone, and return the timestamp as milliseconds since epoch.
   */
  parseFormattedToEpochMilliSeconds(
    timestamp: string,
    format: string,
    timezone: string
  ): number;

  /**
   * Parses an ISO8601 timestamp, passed as a String, and return the timestamp as milliseconds since epoch.
   */
  parseISO8601ToEpochMilliSeconds(timestamp: string): number;

  /**
   * Converts an epoch milliseconds timestamp to an epoch seconds timestamp.
   */
  epochMilliSecondsToSeconds(epoch: number): number;

  /**
   * Converts a epoch milliseconds timestamp to an ISO8601 timestamp.
   */
  epochMilliSecondsToISO8601(epoch: number): string;

  /**
   * Converts a epoch milliseconds timestamp, passed as long, to a timestamp formatted according to the supplied format in UTC.
   */
  epochMilliSecondsToFormatted(epoch: number, format: string): string;

  /**
   * Converts a epoch milliseconds timestamp, passed as a long, to a timestamp formatted according to the supplied format in the supplied timezone.
   */
  epochMilliSecondsToFormatted(
    epoch: number,
    format: string,
    timezone: string
  ): string;
}

const uniqueNamesSymbol = Symbol.for("functionless.UniqueNames");

const names: WeakMap<
  appsync.GraphqlApi,
  {
    [name: string]: number;
  }
> = ((global as any)[uniqueNamesSymbol] ??= new WeakMap());

function getUniqueName(api: appsync.GraphqlApi, name: string): string {
  let uniqueNames = names.get(api);
  if (uniqueNames === undefined) {
    uniqueNames = {};
    names.set(api, uniqueNames);
  }
  const counter = uniqueNames[name];
  if (counter === undefined) {
    uniqueNames[name] = 0;
    return name;
  } else {
    uniqueNames[name] += 1;
    return `${name}_${counter}`;
  }
}

const dataSourcesSymbol = Symbol.for("functionless.DataSources");

const dataSources: WeakMap<
  appsync.GraphqlApi,
  WeakMap<any, appsync.BaseDataSource>
> = ((global as any)[dataSourcesSymbol] ??= new WeakMap());

function getDataSources(api: appsync.GraphqlApi) {
  if (!dataSources.has(api)) {
    dataSources.set(api, new WeakMap());
  }
  return dataSources.get(api)!;
}

const None = {
  none: Symbol.for("functionless.None"),
};

// @ts-ignore
function getDataSource(
  api: appsync.GraphqlApi,
  target: CanReference | null,
  compute: () => appsync.BaseDataSource
): appsync.BaseDataSource {
  const ds = getDataSources(api);
  const key = target ?? None;
  if (!ds.has(key)) {
    ds.set(key, compute());
  }
  return ds.get(key)!;
}
