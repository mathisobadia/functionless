import { Construct } from "constructs";
import { aws_dynamodb, aws_lambda } from "aws-cdk-lib";
import {
  Table,
  Function,
  $util,
  AppsyncResolver,
  ResolverArguments,
  ResolverFunction,
} from "functionless";
import { QueryResolvers, MutationResolvers, Person } from "./generated-types";

export class PeopleDatabase extends Construct {
  readonly personTable;
  readonly computeScore;
  readonly getPerson;
  readonly addPerson;
  readonly updateName;
  readonly deletePerson;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.personTable = new Table<Person, "id", undefined>(
      new aws_dynamodb.Table(this, "table", {
        partitionKey: {
          name: "id",
          type: aws_dynamodb.AttributeType.STRING,
        },
      })
    );

    this.computeScore = new Function<(person: Person) => number>(
      new aws_lambda.Function(this, "ComputeScore", {
        code: aws_lambda.Code.fromInline(
          "exports.handle = async function() {return 1;}"
        ),
        handler: "index.handle",
        runtime: aws_lambda.Runtime.NODEJS_14_X,
      })
    );

    this.getPerson = new AppsyncResolverWrapper<QueryResolvers["getPerson"]>(
      ($context) => {
        const person = this.personTable.getItem({
          key: {
            id: $util.dynamodb.toDynamoDB($context.arguments.id),
          },
          consistentRead: true,
        });

        if (person === undefined) {
          return undefined;
        }

        const score = this.computeScore(person);
        return {
          ...person,
          score,
        };
      }
    );

    this.addPerson = new AppsyncResolverWrapper<MutationResolvers["addPerson"]>(
      ($context) => {
        const person = this.personTable.putItem({
          key: {
            id: {
              S: $util.autoId(),
            },
          },
          attributeValues: {
            name: {
              S: $context.arguments.input.name,
            },
          },
        });

        return person;
      }
    );

    // example of inferring the TArguments and TResult from the function signature
    this.updateName = new AppsyncResolverWrapper<
      MutationResolvers["updateName"]
    >(($context) =>
      this.personTable.updateItem({
        key: {
          id: $util.dynamodb.toDynamoDB($context.arguments.id),
        },
        update: {
          expression: "SET #name = :name",
          expressionNames: {
            "#name": "name",
          },
          expressionValues: {
            ":name": $util.dynamodb.toDynamoDB($context.arguments.name),
          },
        },
      })
    );

    // example of explicitly specifying TArguments and TResult
    this.deletePerson = new AppsyncResolverWrapper<
      MutationResolvers["deletePerson"]
    >(($context) =>
      this.personTable.deleteItem({
        key: {
          id: $util.dynamodb.toDynamoDB($context.arguments.id),
        },
      })
    );
  }
}

type ResolverBase = {
  args: ResolverArguments;
  parent: unknown;
  result: unknown;
};

class AppsyncResolverWrapper<
  ResolverType extends ResolverBase
> extends AppsyncResolver<
  ResolverType["args"],
  ResolverType["result"],
  ResolverType["parent"]
> {
  constructor(
    fn: ResolverFunction<
      ResolverType["args"],
      ResolverType["result"],
      ResolverType["parent"]
    >
  ) {
    super(fn);
  }
}
