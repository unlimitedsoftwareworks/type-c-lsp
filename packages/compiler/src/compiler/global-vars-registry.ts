import { AstNode } from "langium"
import * as ast from 'type-c-language';

export class GlobalVariablesRegistery {
    nodeMap: Map<AstNode, string> = new Map();
    nameCounter: Map<string, number> = new Map();

    /**
     * Get or generate a mangled name for a global variable node.
     * @param node Either VariableDeclSingle or DestructuringElement
     * @param name Optional explicit name to use instead of extracting from node
     * @returns The mangled name (unique across different nodes, consistent for same node)
     */
    G(node: AstNode, name?: string): string {
        // If we've already seen this node, return the stored mangled name
        if (this.nodeMap.has(node)) {
            return this.nodeMap.get(node)!;
        }
        
        // Get the base name (from parameter or extract from node)
        const baseName = name ?? this.extractNodeName(node);
        
        // Generate a unique mangled name
        let mangledName: string;
        if (this.nameCounter.has(baseName)) {
            // Name already used, append counter to make it unique
            const counter = this.nameCounter.get(baseName)!;
            mangledName = `${baseName}_${counter}`;
            this.nameCounter.set(baseName, counter + 1);
        } else {
            // First time seeing this name
            mangledName = baseName;
            this.nameCounter.set(baseName, 1);
        }
        
        // Store the mapping and return the mangled name
        this.nodeMap.set(node, mangledName);
        return mangledName;
    }

    /**
     * Extract the name from a node
     * @param node Either VariableDeclSingle or DestructuringElement
     * @returns The variable name, or '_' if not available
     */
    private extractNodeName(node: AstNode): string {
        if (ast.isVariableDeclSingle(node)) {
            return node.name;
        }
        if (ast.isDestructuringElement(node)) {
            return node.name || '_';
        }
        if ('name' in node) {
            return node['name'] as string;
        }
        // Fallback for other node types
        return '_unknown';
    }
}