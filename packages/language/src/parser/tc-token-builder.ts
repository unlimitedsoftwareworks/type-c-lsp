import { createToken, type TokenType } from 'chevrotain';
import { DefaultTokenBuilder, GrammarAST } from 'langium';

export class TypeCTokenBuilder extends DefaultTokenBuilder {
    readonly stmtEndTokenType: TokenType;

    constructor() {
        super();
        this.stmtEndTokenType = createToken({
            name: 'STMT_END',
            pattern: () => null, // Never matches during lexing
            line_breaks: false,
        });
    }

    protected override buildTerminalToken(terminal: GrammarAST.TerminalRule): TokenType {
        if (terminal.name === 'STMT_END') {
            return this.stmtEndTokenType;
        }
        return super.buildTerminalToken(terminal);
    }
}
