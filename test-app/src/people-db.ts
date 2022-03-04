import { Construct } from "constructs";
import { aws_dynamodb, aws_lambda } from "aws-cdk-lib";
import { Table, Function, $util, AppsyncResolver } from "functionless";

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

    this.getPerson = new AppsyncResolver<
      QueryResolvers["getPerson"]["args"],
      QueryResolvers["getPerson"]["result"],
      QueryResolvers["getPerson"]["parent"]
    >(($context) => {
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
    });

    this.addPerson = new AppsyncResolver<
      MutationResolvers["addPerson"]["args"],
      MutationResolvers["addPerson"]["result"],
      MutationResolvers["addPerson"]["parent"]
    >(($context) => {
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
    });

    // example of inferring the TArguments and TResult from the function signature
    this.updateName = new AppsyncResolver<
      MutationResolvers["updateName"]["args"],
      MutationResolvers["updateName"]["result"],
      MutationResolvers["updateName"]["parent"]
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
    this.deletePerson = new AppsyncResolver<
      MutationResolvers["deletePerson"]["args"],
      MutationResolvers["deletePerson"]["result"],
      MutationResolvers["deletePerson"]["parent"]
    >(($context) =>
      this.personTable.deleteItem({
        key: {
          id: $util.dynamodb.toDynamoDB($context.arguments.id),
        },
      })
    );
  }
}
