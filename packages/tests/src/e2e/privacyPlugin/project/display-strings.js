// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
const button = document.getElementById('loadMore');
const contentDiv = document.getElementById('additionalContent');

button.addEventListener('click', () => {
    const newContent = document.createElement('div');
    newContent.innerHTML = `
            <h2>Additional Content</h2>
            <p>This content was loaded dynamically after clicking the button!</p>
            <p>Here are some more strings to display:</p>
        `;
    contentDiv.appendChild(newContent);
    button.disabled = true; // Disable button after first click
});
