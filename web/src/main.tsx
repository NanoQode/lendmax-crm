import { render } from 'preact';
import { App } from './app.tsx';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
render(<App />, root);
