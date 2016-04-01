var path = require('path');
var webpack = require('webpack');

var webpackConfig = {
    entry: './src/tests/NoSqlProviderTests.ts',
    
    output: {
        filename: './NoSQLProviderTestsPack.js',
    },

    resolve: {
        root: [
            path.resolve('./src'),
            path.resolve('./node_modules')
        ],
        extensions: ['', '.ts', '.js']
    },
    
    externals: [ 'sqlite3', 'indexeddb-js' ],
    
    module: {
        loaders: [{
            // Compile TS.
            test: /\.tsx?$/, 
            exclude: /node_modules/,
            loader: 'ts-loader'
        }]
    }  
};

module.exports = webpackConfig;
