var path = require('path');
var webpack = require('webpack');

var webpackConfig = {
    entry: './src/tests/NoSqlProviderTests.ts',
    
    output: {
        filename: './NoSQLProviderTestsPack.js',
    },

    externals: [ 'sqlite3', 'indexeddb-js', 'fs' ],
    
    resolve: {
        modules: [
            path.resolve('./src'),
            path.resolve('./node_modules')
        ],
        extensions: ['.ts', '.tsx', '.js']
    },
    
    module: {
        rules: [{
            // Compile TS.
            test: /\.tsx?$/, 
            exclude: /node_modules/,
            loader: 'awesome-typescript-loader'
        }]
    }  
};

module.exports = webpackConfig;
