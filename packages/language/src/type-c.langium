grammar TypeC

entry Module:
    MainProgram;

interface Program {
    imports: Import[];
    definitions: (
        NamespaceDecl | 
        FunctionDeclaration | 
        TypeDeclaration | 
        ExternFFIDecl | 
        VariableDeclarationStatement |
        ClassType |
        ImplementationType |
        BuiltinDefinition
    )[];
}

fragment MainProgram returns Program:
    imports+=Import*
    GlobalDefinition*;

Import:
    'from' sourcePackage=QualifiedName 'import' SubImports |
    'from' sourcePackage=QualifiedName 'import' importAll?='*';

fragment SubImports:
    modules+=SubModule (',' modules+=SubModule)*;

SubModule:
    reference=[IdentifiableReference:ID] ('as' alias=ID)?;

fragment GlobalDefinition:
    definitions+=(NamespaceDecl | FnDecl<true> | CFnDecl<true> | TypeDecl<true> | VariableDeclarationStatement<true> | ExternFFIDecl | BuiltinDefinition) ;

ExternFFIDecl:
    (isLocal?='local')? 'extern' name=ID 'from' dynlib=STRING '='? '{' 
        methods+=ExternMethodHeader*
    '}';

ExternMethodHeader infers FFIMethodHeader:
    'fn' name=ID header=FnHeader;


NamespaceDecl:
    isLocal?='local'? 'namespace' name=ID '{'
        GlobalDefinition*
    '}';

interface FunctionDeclaration {
    isLocal?: boolean;
    fnType: 'fn' | 'cfn';
    name: string;
    genericParameters?: GenericType[];
    header: FunctionHeader;
    body?: BlockStatement;
    expr?: Expression;
}

FnDecl<allowLocal> returns FunctionDeclaration:
    (<allowLocal>isLocal?='local')?
    fnType='fn' 
    name=ID 
    GenericDecl? 
    header=FnHeader 
    (
        ('=' expr=TupleExpression) | 
        (body=BlockStatement)
    );

CFnDecl<allowLocal> returns FunctionDeclaration:
    (<allowLocal>isLocal?='local')?
    fnType='cfn' 
    name=ID 
    GenericDecl? 
    header=FnHeader 
    (
        ('=' expr=TupleExpression) | 
        (body=BlockStatement)
    );

interface FunctionHeader {
    args: FunctionParameter[];
    returnType: DataType;
}


interface FunctionTypeHeader {
    args: FunctionTypeParameter[];
    returnType: DataType;
}

FnHeader returns FunctionHeader:
    '(' ((args+=FnParam) (',' args+=FnParam)*)? ')' ('->' returnType=DataType<true>)?;

FnTypeHeader returns FunctionTypeHeader:
    '(' ((args+=FnTypeParam) (',' args+=FnTypeParam)*)? ')' ('->' returnType=DataType<true>)?;


interface FunctionParameter {
    isMut: boolean;
    name: string;
    type: DataType;
}
FnParam returns FunctionParameter:
    (isMut?='mut')? name=ID ':' type=DataType<false>;


interface FunctionTypeParameter {
    isMut: boolean;
    name?: string;
    type: DataType;
}

FnTypeParam returns FunctionTypeParameter:
    (isMut?='mut')? (name=ID ':')? type=DataType<false>;


fragment GenericDecl:
    GENERICS_OPEN (genericParameters+=GenericTypeDeclaration (',' genericParameters+=GenericTypeDeclaration)*) '>';

interface GenericType {
    name: string;
    constraint?: DataType;
}
GenericTypeDeclaration returns GenericType:
    name=ID (':' constraint=DataType<false>)?;

/**
 * Variable Declarations:
 */
interface VariablesDeclarations {
    variables: VariableDeclaration[];
}
VariablesDecls<allowLocal>:
    (<allowLocal>isLocal?='local')? 'let' (variables+=VariableDecl (',' variables+=VariableDecl)*);

interface VariableDeclaration {
    isConst: boolean;
    name: string;
    annotation?: DataType;
    initializer: Expression;
}
VariableDecl returns VariableDeclaration:
    VariableDeclSingle |
    VariableDeclArrayDestructuring |
    VariableDeclStructDestructuring |
    VariableDeclTupleDestructuring {
        infer VariableDefinition
    };

VariableDeclSingle:
    (isConst?='const')? name=ID ((':' annotation=DataType<false>) | (isNullable?='?'))? '=' initializer=Expression;

VariableDeclArrayDestructuring:
    (isConst?='const')? '[' elements+=DestructuringElement<true, false> (',' elements+=DestructuringElement<true, false>)* ']' (':' annotation=DataType<false>)? '=' initializer=Expression;

VariableDeclStructDestructuring:
    (isConst?='const')? '{' elements+=DestructuringElement<true, true> (',' elements+=DestructuringElement<true, true>)* '}' (':' annotation=DataType<false>)? '=' initializer=Expression;

VariableDeclTupleDestructuring:
    (isConst?='const')? '(' elements+=DestructuringElement<false, false> (',' elements+=DestructuringElement<false, false>)* ')' (':' annotation=DataType<false>)? '=' initializer=Expression;

DestructuringElement<allowDestructuring, allowNameOverride>:
    (<allowDestructuring>(isSpread?='...')?) (<allowNameOverride> (originalName=ID ':')?) name=ID isNullable?='?'? |
    WILDCARD;

/**
 * Expressions
 */
TupleExpression infers Expression:
    {infer TupleExpression} '(' expressions+=Expression (',' expressions+=Expression)* ')' |
    {infer Expression} Expression;

Expression:
    AssignmentExpression;

// If expression
IfExpression infers Expression:
    'if' {infer ConditionalExpression.value = current } conditions+=Expression '=>' thens+=Expression
        ('else' 'if' conditions+=Expression '=>' thens+=Expression)*
        ('else' elseExpr=Expression)?;

// Match expression
MatchExpression infers Expression:
    'match' { infer MatchExpression} target=Expression '{'
        (cases+=MatchCaseExpression ',')*
        // always a final trail case
        WILDCARD '=>' defaultExpr=Expression ","?
    '}';

MatchCaseExpression:
    pattern=MatchCasePattern ('if' guard=Expression)? '=>' body=Expression;

// Let-in expression
LetInExpression infers Expression:
    { infer LetInExpression } 'let' (vars+=VariableDecl (',' vars+=VariableDecl)*)? 'in' expr=Expression;

AssignmentExpression infers Expression:
    ConditionalExpression (
        {infer BinaryExpression.left = current} 
        op=('='|'+='|'-='|'*='|'/='|'%='|'&='|'|='|'^='|'<<='|'>>=')
        right=ConditionalExpression
    )*;

ConditionalExpression infers Expression:
    LogicalExpression |
    IfExpression |
    MatchExpression |
    LetInExpression;


LogicalExpression infers Expression:
    LtGtExpression (
        {infer BinaryExpression.left = current}
        op=('&&' | '||' | '??')
        right=LtGtExpression
    )*;

LtGtExpression infers Expression:
    ComparisonExpression (
        {infer BinaryExpression.left = current}
        op=(LESS_THAN | '>')
        right=ComparisonExpression
    )*;


ComparisonExpression infers Expression:
    BitwiseExpression (
        {infer BinaryExpression.left = current}
        op=('==' | '!=' | '<=' | '>=')
        right=BitwiseExpression
    )*;

BitwiseExpression infers Expression:
    ShiftExpression (
        {infer BinaryExpression.left = current}
        op=('&' | '|' | '^')
        right=ShiftExpression
    )*;

ShiftExpression infers Expression:
    AdditiveExpression (
        {infer BinaryExpression.left = current}
        op=('<<' | '>>')
        right=AdditiveExpression
    )*;

AdditiveExpression infers Expression:
    MultiplicativeExpression (
        {infer BinaryExpression.left = current}
        op=('+' | '-')
        right=MultiplicativeExpression
    )*;

MultiplicativeExpression infers Expression:
    UnaryExpression (
        {infer BinaryExpression.left = current}
        op=('*' | '/' | '%')
        right=UnaryExpression
    )*;

UnaryExpression infers Expression:
    {infer UnaryExpression} (op=('!' | '~' | '-' | '+' | '++' | '--') expr=UnaryExpression) |
    {infer ThrowExpression} 'throw' expr=Expression |
    {infer MutateExpression} 'mutate' expr=Expression |
    {infer CoroutineExpression} 'coroutine' fn=Expression |
    {infer YieldExpression} style=('yield'|'yield!') expr=TupleExpression? |
    {infer NewExpression} 'new' (instanceType=DataType<false>)? '(' Args? ')' |
    TypeCheckExpression;

TypeCheckExpression infers Expression:
    PostfixExpression (
        {infer InstanceCheckExpression.left = current} 'is' destType=DataType<false> |
        {infer TypeCastExpression.left = current} castType=('as' | 'as!' | 'as?') destType=DataType<false>
    )*;

/**
 * Postfix expressions: calls, index, ++, --
 */
PostfixExpression infers Expression:
    AtomicExpression (
        //({infer MemberAccessCall.expr = current} ('.'|(isNullable?='?.')?) element=[IdentifiableReference:ID]) GenericArgs? '(' Args? ')' |
        ({infer MemberAccess.expr = current} ('.'|(isNullable?='?.')) element=[IdentifiableReference:ID]) |
        ({infer FunctionCall.expr = current} GenericArgs? '(' Args? ')') |
        //({infer GenericFunctionCall.expr = current}  '(' Args? ')') |
        ({infer ReverseIndexSet.expr = current} '[' '-' index=Expression ']' '=' value=Expression) |
        ({infer ReverseIndexAccess.expr = current} '[' '-' index=Expression ']') |
        ({infer IndexSet.expr = current} '[' Indexes ']' '=' value=Expression) |
        ({infer IndexAccess.expr = current} '[' Indexes ']') |
        ({infer PostfixOp.expr = current} op=('++' | '--'))  |
        ({infer DenullExpression.expr = current} '!' )
    )*;

AtomicExpression infers Expression:
    '(' Expression ')' |
    LiteralExpression |
    LambdaExpression |
    { infer ThisExpression } 'this'  |
    DoExpression |
    QualifiedReference |
    ArrayConstructionExpression |
    NamedStructConstructionExpression |
    AnonymousStructConstructionExpression |
    { infer WildcardExpression } WILDCARD |
    { infer UnreachableExpression } 'unreachable';


ArrayConstructionExpression infers Expression:
    {infer ArrayConstructionExpression} '[' ArrayExpressionList? ']';

ArrayExpressionList:
    values+=ArrayElementExpression (',' values+=ArrayElementExpression)*;

ArrayElementExpression:
    {infer ExpressionElement } expr=Expression  |
    {infer ArraySpreadExpression} '...' expr=Expression;

AnonymousStructConstructionExpression infers Expression:
    {infer AnonymousStructConstructionExpression} '{' ExpressionList  '}';

NamedStructConstructionExpression infers Expression:
    {infer NamedStructConstructionExpression} '{' StructFieldExprList '}';

StructFieldExprList:
    fields+=StructFieldExpr (',' fields+=StructFieldExpr)*;

StructFieldExpr:
    {infer StructFieldKeyValuePair} name=ID ':' expr=Expression |
    {infer StructSpreadExpression} '...' expression=Expression;

/**
 * Example "do" block
 */
DoExpression infers Expression:
    {infer DoExpression} 'do' body=BlockStatement ;

LambdaExpression infers Expression:
    {infer LambdaExpression} fnType=('fn' | 'cfn') header=FnHeader (body=BlockStatement | '=' expr=TupleExpression);

// Example literal
LiteralExpression infers LiteralExpression:
    IntegerLiteral |
    FloatingPointLiteral |
    StringLiteral |
    BinaryStringLiteral |
    BooleanLiteral |
    NullLiteral;

IntegerLiteral:
    value=HEXADECIMAL_INT_LITERAL { infer HexadecimalIntegerLiteral } |
    value=BINARY_INT_LITERAL { infer BinaryIntegerLiteral } |
    value=OCTAL_INT_LITERAL { infer OctalIntegerLiteral } |
    value=DECIMAL_INT_LITERAL { infer DecimalIntegerLiteral };

FloatingPointLiteral:
    value=FLOAT_LITERAL { infer FloatLiteral } |
    value=DOUBLE_LITERAL { infer DoubleLiteral };

BooleanLiteral:
    TRUE_LITERAL { infer TrueBooleanLiteral } |
    FALSE_LITERAL { infer FalseBooleanLiteral };

NullLiteral:
    NULL { infer NullLiteralExpression };

BinaryStringLiteral:
    value=BINARY_STRING { infer BinaryStringLiteralExpression };

StringLiteral:
    value=STRING { infer StringLiteralExpression };


/**
 * Statements:
 */

Statement:
    ExpressionStatement ';'? | // TODO: remove this ; once we figure out the issue of consecutive expresison statements
    BlockStatement |
    BreakStatement |
    ContinueStatement |
    DoWhileStatement |
    ForStatement |
    ForeachStatement |
    FunctionDeclarationStatement |
    IfStatement |
    MatchStatement |
    ReturnStatement |
    VariableDeclarationStatement<false> | 
    WhileStatement;


BlockStatement:
    '{' statements+=Statement* '}';

BreakStatement:
    kind='break';

ContinueStatement:
    kind='continue';

DoWhileStatement:
    kind='do' body=BlockStatement 'while' condition=Expression;

ExpressionStatement:
    expr=Expression;

ForStatement:
    kind='for' (init=Statement)? ';' (condition=Expression)? ';' (update=Expression)? body=BlockStatement;

ForeachStatement:
    kind='foreach'((index=ID ',' value=ID)|(value=ID)) 'in' (collection=Expression) body=BlockStatement;

FunctionDeclarationStatement:
    fn=(FnDecl<false> | CFnDecl<false>);

IfStatement:
    kind='if' condition=Expression body=BlockStatement ('else' elseIf+=IfStatement)* ('else' elseBody=BlockStatement)?;

MatchStatement:
    kind='match' target=Expression '{' cases+=MatchCaseStatement* '}';


MatchCaseStatement:
    pattern=MatchCasePattern ('if' guard=Expression)? body=BlockStatement;

ReturnStatement:
    kind='return' expr=TupleExpression?;

VariableDeclarationStatement<allowLocal>:
    declarations=VariablesDecls<allowLocal>;

WhileStatement:
    kind='while' condition=Expression body=BlockStatement;


/**
 * Data Types:
 */
interface TypeDeclaration {
    isLocal?: boolean;
    name: string;
    genericParameters: GenericType[];
    definition: DataType;
}

TypeDecl<allowLocal> returns TypeDeclaration:
    (<allowLocal>isLocal?='local')? 'type' name=ID GenericDecl? '=' definition=DataType<false>;


DataType<allowTuples>:
    (<allowTuples> TupleType) |
    NullableType;

// cannot have nested tuples
TupleType infers DataType:
    {infer TupleType} '(' types+=NullableType (',' types+=NullableType)+ ')';

NullableType infers DataType:
    UnionType ({infer NullableType.baseType = current} '?')?;

UnionType infers DataType:
    JoinType ({infer UnionType.left = current} '|' right=JoinType)*;

JoinType infers DataType:
    ArrayType ({infer JoinType.left = current} '&' right=ArrayType)*;

ArrayType infers DataType:
    GroupType ({infer ArrayType.arrayOf = current} '['']')*;

GroupType infers DataType:
    '(' DataType<false> ')' |
    PrimeType;

PrimeType infers DataType:
    ReferenceType {infer ReferenceType} |
    PrimitiveType {infer PrimitiveType} |
    StructType {infer StructType} |
    VariantType {infer VariantType} |
    EnumType {infer EnumType} |
    InterfaceType {infer InterfaceType} |
    ClassType {infer ClassType} |
    ImplementationType {infer ImplementationType} |
    FunctionType {infer FunctionType} | 
    CoroutineType {infer CoroutineType} |
    ReturnType {infer ReturnType} |
    StringEnumType {infer StringEnumType};

ReferenceType:
    field=[IdentifiableReference:ID] (
        {infer ReferenceType.parent = current} '.' field=[IdentifiableReference:ID]
    )* 
    GenericArgs?
;

StructType:
    name= 'struct'? '{' fields+=StructField (',' fields+=StructField)* ','? '}';

VariantType:
    'variant' '{' 
        constructors+=VariantConstructor (',' constructors+=VariantConstructor)* ','? 
    '}';

VariantConstructor:
    name=ID ('(' (params+=VariantConstructorField (',' params+=VariantConstructorField)*)? ')')?;


VariantConstructorField:
    name=ID ':' type=DataType<false>;

StructField:
    name=ID ':' type=DataType<false>;

EnumType:
    'enum' ('as' encoding=('u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64'))?  '{' 
        cases+=EnumCase (',' cases+=EnumCase)* ','? 
    '}';

EnumCase:
    name=ID ('=' init=IntegerLiteral)?;

InterfaceType:
    'interface' (superTypes+=DataType<false> (',' superTypes+=DataType<false>)* )?'{' methods+=MethodHeader<false>* '}';

ClassType:
    'class' (superTypes+=DataType<false> (',' superTypes+=(DataType<false>))*)? '{' 
        (ClassAttributesDecl|ClassMethodDecl|ClassStaticBlock|ClassImplementation)* 
    '}';


ImplementationType:
    'impl' ("for" superType=DataType<false>)? '(' 
        (attributes+=ImplementationAttributeDecl ("," attributes+=ImplementationAttributeDecl)*)
    ')' '{'
        (methods+=ImplementationMethodDecl)*
    '}';

ImplementationAttributeDecl:
    isStatic?='static'? isConst?='const'? name=ID ':' type=DataType<false>;

ImplementationMethodDecl:
    isStatic?='static'? method=MethodHeader<true> (body=BlockStatement | '=' expr=TupleExpression);


FunctionType:
    fnType=('fn'|'cfn') header=(FnHeader|FnTypeHeader);

CoroutineType:
    'coroutine' GENERICS_OPEN ('fn' | 'cfn') header=FnHeader '>';

ReturnType:
    'ReturnType' '(' returnType=DataType<false> ')';

StringEnumType:
    cases+=STRING ('|' cases+=STRING)*;

PrimitiveType:
    integerType=('u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64') |
    floatType=('f32' | 'f64') |
    boolType='bool' |
    voidType='void' |
    stringType='string' |
    neverType='never' |
    nullType=NULL;

interface MethodHeader {
    header: FunctionHeader;
    genericParameters?: GenericType[];
    names: string[];
}

MethodHeader<withinClass> returns MethodHeader:
    'fn' MethodNames ((<withinClass> GenericDecl? header=FnHeader) | <!withinClass> header=FnHeader);

fragment ClassAttributesDecl:
    'let' attributes+=ClassAttributeDecl (',' attributes+=ClassAttributeDecl)*;

ClassAttributeDecl:
    // order matters, local static const x: u32
    isLocal?='local'? isStatic?='static'? isConst?='const'? name=ID ':' type=DataType<false> (
        '=' initializer=Expression // optional initializer for class attributes
    )?;

fragment ClassMethodDecl:
   methods+= ClassMethod;

ClassMethod:
    isOverride?='override'? isLocal?='local'?  isStatic?='static'? method=MethodHeader<true> (body=BlockStatement | '=' expr=TupleExpression);
/**
 * TODO: allow keywords as segments
 */
QualifiedName:
    segments+=(ID|"string"|"array"|"coroutine") ('.' segments+=(ID|"string"|"array"|"coroutine"))*;

fragment ClassStaticBlock:
    'static' staticBlock+=BlockStatement;

fragment ClassImplementation:
    implementations+=ClassImplementationMethodDecl;

ClassImplementationMethodDecl:
    'impl' type=DataType<false> '(' (args += ID (',' args += ID)*)? ')';

fragment MethodNames:
    MethodName ('|' MethodName)*;

fragment MethodName:
    names+=ID |
    names+=MethodOperatorName;

MethodOperatorName returns string:
    '+' | 
    '-' |
    '*' | 
    '/' | 
    '%' |  
    LESS_THAN | 
    '>' | 
    LESS_THAN '=' | 
    '>' '=' | 
    '>' '>' | 
    LESS_THAN LESS_THAN | 
    '!' | 
    '~' | 
    '&' | 
    '|' | 
    '^' | 
    '&&' | 
    '||' | 
    '[' ']' | 
    '[' '-' ']' | 
    '[' ']' '=' | 
    '[' '-' ']' '=' | 
    '(' ')' | 
    '+' | 
    '-' | 
    '*' | 
    '/' | 
    '%' | 
    '>' | 
    LESS_THAN | 
    '>=' | 
    LESS_THAN '=' | 
    '<<' | 
    '>' '>' | 
    '&' | 
    '|' | 
    '^' | 
    '&&' | 
    '||' | 
    '-' | 
    '!' | 
    '~' | 
    '++' | 
    '--';


/*
// for simplicity, we only support simple references for now
ReferenceExpr:
    value=ID;
*/

// First define what can be referenced
type IdentifiableReference = 
    FunctionDeclaration | 
    VariableDeclaration | 
    NamespaceDecl | 
    FunctionParameter | 
    TypeDeclaration |
    ClassAttributeDecl |  // Add class attributes
    ClassMethod |         // Add class methods
    VariantConstructor |  // Add variant constructors
    EnumCase |
    GenericType |
    ExternFFIDecl |
    StructField |         // For named struct type fields
    StructFieldKeyValuePair |  // For duck-typed struct literal fields
    BuiltinSymbolID |
    BuiltinSymbolFn;

// Qualified reference that can handle all complex cases
QualifiedReference:
    reference=[IdentifiableReference:ID];

fragment Args:
    (args+=Expression (',' args+=Expression)*);

fragment Indexes:
    indexes+=Expression (',' indexes+=Expression)*;

fragment GenericArgs:
    GENERICS_OPEN genericArgs+=DataType<false> (',' genericArgs+=DataType<false>)* '>';

fragment ExpressionList:
    expressions+=Expression (',' expressions+=Expression)*;

// Also need to add back MatchCasePattern for pattern matching
MatchCasePattern:
    LiteralPattern | 
    ArrayPattern |
    StructPattern |
    TypePattern |
    VariablePattern |
    WildCardPattern;

VariablePattern:
    name=ID;

LiteralPattern:
    IntegerLiteral |
    FloatingPointLiteral |
    BooleanLiteral |
    NullLiteral |
    StringLiteral;

ArrayPattern:
    '[' pattners+=MatchCasePattern (',' pattners+=MatchCasePattern)* (',' '...' trailVariable=ID)? ']';

StructPattern:
    '{' fields+=StructFieldExpr (',' fields+=StructFieldExpr)* (',' '...' trailVariable=ID)? '}';

TypePattern:
    VariantConstructorPattern |
    AnonymousVariantPattern |
    TypeInstancePattern;

VariantConstructorPattern:
    base=[ReferenceType:ID] '.' constructor=[VariantConstructor:ID] '(' params+=MatchCasePattern (',' params+=MatchCasePattern)* ')';

AnonymousVariantPattern:
    // ignores the base! ::Ok(v)
    // useful when we know the base! 
    //match response 
    //  { ::Ok(v) => v,  ::Error(e) => e, _ => unreachable }
    // where response is a variant type
    // TODO: maybe remove the `::` prefix?
    '::' base=[VariantConstructor:ID] '(' params+=MatchCasePattern (',' params+=MatchCasePattern)* ')';

TypeInstancePattern:
    type=DataType<false>;



WildCardPattern:
    {infer WildcardPattern} WILDCARD;


/**
 * Builtins are definitions used to resolve symbols such as array.length and such.
 * Currently applicable to coroutines and arrays.
 */
BuiltinDefinition:
    'prototype' 'for' name=('array' | 'coroutine' | 'string') '{' symbols+=BuiltinSymbol (symbols+=BuiltinSymbol)* '}'
;

BuiltinSymbol:
    {infer BuiltinSymbolID} name=ID ':' type=DataType<false> |
    {infer BuiltinSymbolFn} 'fn' MethodNames GenericDecl? '(' ((args+=FnParam) (',' args+=FnParam)*)? ')' '->' returnType=DataType<true>;


 
hidden terminal WS: /\s+/;

// Lookahead to distinguish < as generic open from < as less-than operator
// This pattern is more permissive to handle nested generics like Array<Array<u32>>
// It looks for < followed by valid type syntax (identifiers, commas, nested <>, etc.) and ending with >
// Treat `<` as GENERICS_OPEN only if there is a `>` later in the same "segment"
terminal GENERICS_OPEN: /<(?=(?:(?!&&|\|\||==|!=|<=|>=|=).)*>)/;
terminal LESS_THAN: /</;

/**
 * Literals, order matters.
 */

// Float literal: Supports numbers with fractional parts, exponent, and 'f' or 'F' suffix
// Same as double but with 'f' or 'F' suffix
terminal FLOAT_LITERAL: /([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+[eE][+-]?[0-9]+)([eE][+-]?[0-9]+)?[fF]/;

// Double literal: Supports numbers with fractional parts, exponent, but no 'f' or 'F' suffix
terminal DOUBLE_LITERAL: /([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+[eE][+-]?[0-9]+)([eE][+-]?[0-9]+)?/;

// Hexadecimal with optional type suffix
// 0x1234u32 -> a u32 literal
terminal HEXADECIMAL_INT_LITERAL: /0x[0-9a-fA-F]+([ui](8|16|32|64))?/;

// Binary with optional type suffix
terminal BINARY_INT_LITERAL: /0b[0-1]+([ui](8|16|32|64))?/;

// Octal with optional type suffix
terminal OCTAL_INT_LITERAL: /0o[0-7]+([ui](8|16|32|64))?/;

// Decimal with optional type suffix
terminal DECIMAL_INT_LITERAL: /[0-9]+([iu](8|16|32|64))?/;


// binary string: b"hello", treated as u8[]
terminal BINARY_STRING: /b"[^"]*"/;

// regular string: "hello", treated as std interface/class
terminal STRING: /"[^"]*"/;

terminal TRUE_LITERAL: 'true';
terminal FALSE_LITERAL: 'false';
terminal NULL: 'null';
terminal ID: /(_[a-zA-Z0-9_]+|[a-zA-Z][a-zA-Z0-9_]*)/;
terminal WILDCARD: '_';
terminal UPPERCASE_ID: /[A-Z][a-zA-Z0-9_]*[?!]?/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
