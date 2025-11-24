export type TypeCModuleConfig = {
	name: string;
	version: string;
	description: string;
	author: string;
	license: string;
	dependencies: Record<string, string>;
	compiler: {
		"target": "library" | "runnable"		
	}

	dependenciesFolder: string;
	sourceFolder: string;
}