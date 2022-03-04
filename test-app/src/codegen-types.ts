export type ResolverFn<TResult, TParent, TContext, TArgs> = {
  args: TArgs;
  context: TContext;
  result: TResult;
  parent: TParent;
};
